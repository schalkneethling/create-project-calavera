// @ts-check
import { LOOPBACK_HOSTS, TARBALL_RULE } from "./tarball-url.js";

// Which redirects Calavera lets pacote follow (#1207). make-fetch-happen follows a redirect itself
// (`fetch` in make-fetch-happen/lib/fetch.js), through its cache or with a new request for each
// hop, and offers no hook for it. Each network request passes the `agent` option to minipass-fetch,
// which calls an agent function with that request's URL before it opens a connection
// (`getNodeRequestOptions` in minipass-fetch/lib/request.js). A function agent therefore sees
// every hop that reaches the network, and an error it throws ends the fetch before anything is
// sent: minipass-fetch rejects with it unchanged. make-fetch-happen would retry it like any error
// it does not know (`remoteFetch` in lib/remote.js), but Calavera passes no `fetchRetries`, so
// npm-registry-fetch asks for no retries; with retries, each attempt would be refused the same way.

const DOWNGRADE_RULE =
  "Calavera does not follow a redirect from https to plain http, except to localhost, 127.0.0.1, or ::1.";
const HOST_RULE =
  "Calavera follows a redirect over plain http only to the registry's own host, or to localhost, 127.0.0.1, or ::1.";

/**
 * An agent function for one pacote call that refuses a hop to plain http on a host that is not
 * loopback when the request was on https before, and, for a tarball download, at any point,
 * because #1194 allows a tarball only from https or loopback http. A lookup that stayed on plain
 * http, on a registry the rules allow, may reach only the registry's own host over http, with host
 * and port as the URL parser writes them (owner decision 1 on #1207): the person named that
 * registry, not wherever it redirects. It otherwise returns the agent `agent` chooses for that URL.
 * `startUrl` is the URL the call requests first: the registry for a
 * lookup and the tarball URL for a download. A hop that make-fetch-happen serves from its cache,
 * such as a stored 301, never reaches the agent, so a lookup that starts on https counts as on
 * https from the start, not from the first hop the agent sees.
 * The error names the package and the two protocols, never a URL, which can carry a token, and
 * `otherHost` says whether the refusal is the registry's own-host rule.
 * @param {{ packageName: string, download: boolean, startUrl: string, agent: (url: URL) => unknown }} request
 * @returns {(url: URL) => unknown}
 */
export function redirectGuard({ packageName, download, startUrl, agent }) {
  const start = new URL(startUrl);
  let wasHttps = start.protocol === "https:";
  let requests = 0;
  return (url) => {
    requests += 1;
    // minipass-fetch refuses every protocol other than http and https before it calls the agent,
    // so a URL that is not https here is http.
    if (url.protocol === "https:") wasHttps = true;
    else if (!LOOPBACK_HOSTS.has(url.hostname)) {
      if (wasHttps || download) throw refusal(packageName, download, wasHttps, false, requests);
      if (url.host !== start.host) throw refusal(packageName, download, false, true, requests);
    }
    return agent(url);
  };
}

/**
 * @param {string} packageName
 * @param {boolean} download
 * @param {boolean} wasHttps
 * @param {boolean} otherHost Whether a plain-http lookup was sent to another plain-http host.
 * @param {number} requests How many requests the agent saw, this one included, for debugging.
 */
function refusal(packageName, download, wasHttps, otherHost, requests) {
  const protocol = wasHttps ? "https:" : "http:";
  const subject = download ? "tarball download" : "package document lookup";
  const message = otherHost
    ? `a redirect led its ${subject} from http: to http: on another host that is not loopback. ${HOST_RULE}`
    : `a redirect led its ${subject} from ${protocol} to http: on a host that is not loopback. ${download ? TARBALL_RULE : DOWNGRADE_RULE}`;
  return Object.assign(new Error(`Calavera did not fetch ${packageName}: ${message}`), {
    code: "EINSECUREREDIRECT",
    packageName,
    protocol,
    redirectProtocol: "http:",
    download,
    otherHost,
    requests,
  });
}

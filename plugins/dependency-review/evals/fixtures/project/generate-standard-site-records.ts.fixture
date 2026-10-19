import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { parse } from "devalue";

import { isPublishedPost } from "../src/lib/postFilters.ts";
import {
  standardSite,
  type StandardSitePublicationConfig,
} from "../src/lib/standardSite.ts";
import {
  createDocumentPayloads,
  createPublicationPayload,
  type StandardSitePost,
} from "../src/lib/standardSitePayloads.ts";

export function createStandardSitePlan(
  posts: readonly StandardSitePost[],
  config: StandardSitePublicationConfig = standardSite,
) {
  const documents = posts
    .filter((post) => isPublishedPost(post))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((post) => {
      if (!post.data.standardSite) {
        return { id: post.id, action: "skip", reason: "not selected" };
      }

      if (!post.data.standardSite.publish) {
        return { id: post.id, action: "skip", reason: "publishing disabled" };
      }

      const payload = createDocumentPayloads([post], config)[0];

      if (!payload) {
        return {
          id: post.id,
          action: "skip",
          reason: "ineligible canonical URL",
        };
      }

      const documentAtUri = post.data.standardSite.documentAtUri;
      return {
        id: post.id,
        action: documentAtUri ? "update" : "create",
        reason: documentAtUri
          ? "document AT-URI configured"
          : "document AT-URI missing",
        ...(documentAtUri ? { documentAtUri } : {}),
        ...(post.filePath ? { sourcePath: post.filePath } : {}),
        payload,
      };
    });

  return {
    version: 1,
    publication: {
      action: config.identity.publicationAtUri ? "update" : "create",
      reason: config.identity.publicationAtUri
        ? "publication AT-URI configured"
        : "publication AT-URI missing",
      ...(config.identity.publicationAtUri
        ? { publicationAtUri: config.identity.publicationAtUri }
        : {}),
      payload: createPublicationPayload(config),
    },
    documents,
  };
}

async function loadPosts() {
  const store = parse(
    await readFile(resolve("node_modules/.astro/data-store.json"), "utf8"),
  ) as Map<string, Map<string, StandardSitePost>>;
  return [...(store.get("posts")?.values() ?? [])];
}

export async function prepareStandardSitePlan() {
  const sync = spawnSync("pnpm", ["exec", "astro", "sync", "--force"], {
    encoding: "utf8",
  });

  process.stderr.write(sync.stdout);
  process.stderr.write(sync.stderr);

  if (sync.status !== 0) {
    throw new Error(
      `Astro content sync failed with status ${sync.status ?? 1}`,
    );
  }

  return createStandardSitePlan(await loadPosts());
}

async function main() {
  const plan = await prepareStandardSitePlan();
  const counts = Object.groupBy(plan.documents, (document) => document.action);

  console.error(
    `DRY RUN: publication ${plan.publication.action}; documents ${counts.create?.length ?? 0} create, ${counts.update?.length ?? 0} update, ${counts.skip?.length ?? 0} skip`,
  );
  console.log(JSON.stringify(plan, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}

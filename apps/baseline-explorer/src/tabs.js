/**
 * @param {number} currentIndex
 * @param {string} key
 * @param {number} tabCount
 * @returns {number | null}
 */
export function tabFocusIndex(currentIndex, key, tabCount) {
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  if (key === "ArrowLeft") return (currentIndex - 1 + tabCount) % tabCount;
  if (key === "ArrowRight") return (currentIndex + 1) % tabCount;
  return null;
}

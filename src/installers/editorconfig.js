import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FileWriteError } from "../utils/file-write-error.js";
import { logger } from "../utils/logger.js";

const configureEditorConfig = async (rootFolderPath) => {
  const editorConfig = `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true\n`;

  try {
    logger.info("🧶 Adding EditorConfig to the project...");

    await writeFile(resolve(rootFolderPath, ".editorconfig"), editorConfig);
  } catch (error) {
    throw new FileWriteError("Failed to add EditorConfig.", {
      cause: error,
    });
  }
};

export default configureEditorConfig;

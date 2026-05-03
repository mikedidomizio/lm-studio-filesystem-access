import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { existsSync } from "fs";
import { copyFile as copyFileToDisk, cp as copyDirectoryToDisk, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "fs/promises";
import { join, basename, dirname, resolve, sep } from "path";
import { z } from "zod";
import { configSchematics } from "./config";

type ToolSuccess<T> = {
  ok: true;
  operation: string;
  data: T;
};

type ToolFailure = {
  ok: false;
  operation: string;
  error: {
    code: string;
    message: string;
  };
};

type SearchMatch = {
  file_name: string;
  relative_path: string;
  score: number;
};

function toSuccessResponse<T>(operation: string, data: T): string {
  const payload: ToolSuccess<T> = { ok: true, operation, data };
  return JSON.stringify(payload);
}

function toErrorResponse(operation: string, code: string, message: string): string {
  const payload: ToolFailure = { ok: false, operation, error: { code, message } };
  return JSON.stringify(payload);
}

function normalizeRelativePath(pathValue: string): string {
  return pathValue.split(sep).join("/");
}

// Helper function to check if a path is within a base directory
function isPathWithinBaseDir(baseDir: string, targetPath: string): boolean {
  // First, resolve both paths to absolute paths to handle all path variations
  const resolvedBaseDir = resolve(baseDir);
  const resolvedTargetPath = resolve(targetPath);

  // Normalize base directory to end with path separator for accurate prefix matching
  // This prevents "/home/user/workspace" from matching "/home/user/workspace-evil"
  const normalizedBaseDir = resolvedBaseDir.endsWith(sep)
    ? resolvedBaseDir
    : resolvedBaseDir + sep;

  // Check if target is exactly the base directory or starts with base directory + separator
  if (resolvedTargetPath !== resolvedBaseDir && !resolvedTargetPath.startsWith(normalizedBaseDir)) {
    return false;
  }

  // Additional security check: prevent directory traversal by ensuring the
  // relative path doesn't contain '..' segments
  const relativePath = resolvedTargetPath.substring(resolvedBaseDir.length);
  const pathSegments = relativePath.split(/[\/\\]/).filter(segment => segment !== '');

  // Check if any path segment is '..', which would indicate directory traversal
  for (const segment of pathSegments) {
    if (segment === '..') {
      return false;
    }
  }

  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeSearchQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter((token) => token.length > 0);
}

function buildLaxSearchRegex(tokens: string[]): RegExp {
  const escapedTokens = tokens.map((token) => escapeRegExp(token));

  if (escapedTokens.length === 0) {
    return /^$/;
  }

  return new RegExp(escapedTokens.join(".*"), "i");
}

function scoreLaxMatch(fileBaseName: string, tokens: string[]): number {
  const normalizedName = fileBaseName.toLowerCase();

  if (normalizedName.length === 0 || tokens.length === 0) {
    return 0;
  }

  let cursor = 0;
  let matchedChars = 0;
  let spanStart = -1;
  let spanEnd = -1;

  for (const token of tokens) {
    const index = normalizedName.indexOf(token, cursor);
    if (index === -1) {
      return 0;
    }

    if (spanStart === -1) {
      spanStart = index;
    }

    matchedChars += token.length;
    spanEnd = index + token.length;
    cursor = index + token.length;
  }

  const coverage = matchedChars / normalizedName.length;
  const spanLength = Math.max(spanEnd - spanStart, 1);
  const compactness = matchedChars / spanLength;
  const startsAtBeginningBonus = spanStart === 0 ? 0.05 : 0;
  const score = (coverage * 0.5) + (compactness * 0.45) + startsAtBeginningBonus;

  return Number(Math.min(score, 0.99).toFixed(4));
}

async function collectRelativeFilesRecursive(baseDir: string, currentDir = ""): Promise<string[]> {
  const absoluteDir = currentDir ? join(baseDir, currentDir) : baseDir;
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = currentDir ? join(currentDir, entry.name) : entry.name;
    const absolutePath = join(baseDir, relativePath);

    if (!isPathWithinBaseDir(baseDir, absolutePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await collectRelativeFilesRecursive(baseDir, relativePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(normalizeRelativePath(relativePath));
    }
  }

  return files;
}

export async function toolsProvider(ctl: ToolsProviderController) {
  const tools: Tool[] = [];

  // =============
  // FILE TOOLS
  // =============

  // === WRITE FILE TOOL ===
  // Writes files to the configured directory
  const writeFileTool = tool({
    name: `write_file`,
    description: "Write or update a file with the given name and content. Creates the file if it doesn't exist. Supports subdirectories.",
    parameters: {
      file_name: z
        .string()
        .min(1, "File name cannot be empty")
        .refine((value) => value.trim().length > 0, "File name cannot be empty"),
      content: z.string()
    },
    implementation: async ({ file_name, content }) => {
      console.log("write_file tool called with parameters:", { file_name, content });
      const operation = "write_file";
      // Check if directory is set
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");
      if (!folderName) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }

      // Validate that the file path is within the configured directory
      const fullPath = join(folderName, file_name);

      // Security check: ensure the path is within the configured directory
      // Allow paths with "/" in filenames (subdirectories) but prevent traversal outside the folder
      if (!isPathWithinBaseDir(folderName, fullPath)) {
        return toErrorResponse(operation, "FILE_PATH_OUTSIDE_BASE", "File path is outside the configured directory.");
      }

      const fileAlreadyExists = existsSync(fullPath);

      // Create directory structure if needed
      const fileDir = dirname(fullPath);
      if (!existsSync(fileDir)) {
        await mkdir(fileDir, { recursive: true });
      }
      
      try {
        // Write file (creates or overwrites)
        await writeFile(fullPath, content, "utf-8");
      } catch {
        return toErrorResponse(operation, "WRITE_FAILED", "Failed to write file");
      }

      return toSuccessResponse(operation, {
        file_name: basename(file_name),
        relative_path: normalizeRelativePath(file_name),
        created: !fileAlreadyExists,
        updated: fileAlreadyExists,
      });
    },
  });
  tools.push(writeFileTool);

  // === READ FILE TOOL ===
  // Reads files from the configured directory
  const readFileTool = tool({
    name: `read_file`,
    description: "Read the content of a file from the configured directory.",
    parameters: {
      file_name: z
        .string()
        .min(1, "File name cannot be empty")
        .refine((value) => value.trim().length > 0, "File name cannot be empty")
    },
    implementation: async ({ file_name }) => {
      console.log("read_file tool called with parameters:", { file_name });
      const operation = "read_file";
      // Check if directory is set
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");
      if (!folderName) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }
      
      // Validate that the file path is within the configured directory
      const fullPath = join(folderName, file_name);

      // Security check: ensure the path is within the configured directory
      if (!isPathWithinBaseDir(folderName, fullPath)) {
        return toErrorResponse(operation, "FILE_PATH_OUTSIDE_BASE", "File path is outside the configured directory.");
      }

      // Build file path
      const filePath = fullPath;
      
      // Check if file exists
      if (!existsSync(filePath)) {
        return toErrorResponse(operation, "FILE_NOT_FOUND", "File does not exist");
      }
      
      try {
        // Read and return content
        const content = await readFile(filePath, "utf-8");
        return toSuccessResponse(operation, {
          file_name: basename(file_name),
          relative_path: normalizeRelativePath(file_name),
          content,
        });
      } catch {
        return toErrorResponse(operation, "READ_FAILED", "Failed to read file");
      }
    },
  });
  tools.push(readFileTool);

  // === DELETE FILE TOOL ===
  // Deletes a file within the configured directory.
  const deleteFileTool = tool({
    name: `delete_file`,
    description: "Delete a file from the configured directory.",
    parameters: {
      file_name: z
        .string()
        .min(1, "File name cannot be empty")
        .refine((value) => value.trim().length > 0, "File name cannot be empty"),
    },
    implementation: async ({ file_name }) => {
      console.log("delete_file tool called with parameters:", { file_name });
      const operation = "delete_file";
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");

      if (!folderName || !existsSync(folderName)) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }

      const fullPath = join(folderName, file_name);
      if (!isPathWithinBaseDir(folderName, fullPath)) {
        return toErrorResponse(operation, "FILE_PATH_OUTSIDE_BASE", "File path is outside the configured directory.");
      }

      if (!existsSync(fullPath)) {
        return toErrorResponse(operation, "FILE_NOT_FOUND", "File does not exist");
      }

      const fileStats = await stat(fullPath);
      if (!fileStats.isFile()) {
        return toErrorResponse(operation, "FILE_NOT_FILE", "Path is not a file");
      }

      await unlink(fullPath);

      return toSuccessResponse(operation, {
        file_name: basename(file_name),
        relative_path: normalizeRelativePath(file_name),
        deleted: true,
      });
    },
  });
  tools.push(deleteFileTool);

  // === COPY FILE TOOL ===
  // Copies a file within the configured directory.
  const copyFileTool = tool({
    name: `copy_file`,
    description: "Copy a file to a new path within the configured directory.",
    parameters: {
      source_path: z
        .string()
        .min(1, "Source path cannot be empty")
        .refine((value) => value.trim().length > 0, "Source path cannot be empty"),
      destination_path: z
        .string()
        .min(1, "Destination path cannot be empty")
        .refine((value) => value.trim().length > 0, "Destination path cannot be empty"),
      overwrite: z.boolean().optional(),
    },
    implementation: async ({ source_path, destination_path, overwrite = false }) => {
      console.log("copy_file tool called with parameters:", { source_path, destination_path, overwrite });
      const operation = "copy_file";
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");

      if (!folderName || !existsSync(folderName)) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }

      const sourceFullPath = join(folderName, source_path);
      const destinationFullPath = join(folderName, destination_path);

      if (!isPathWithinBaseDir(folderName, sourceFullPath)) {
        return toErrorResponse(operation, "SOURCE_PATH_OUTSIDE_BASE", "Source path is outside the configured directory.");
      }

      if (!isPathWithinBaseDir(folderName, destinationFullPath)) {
        return toErrorResponse(operation, "DESTINATION_PATH_OUTSIDE_BASE", "Destination path is outside the configured directory.");
      }

      if (resolve(sourceFullPath) === resolve(destinationFullPath)) {
        return toErrorResponse(operation, "SOURCE_EQUALS_DESTINATION", "Source and destination paths must be different.");
      }

      if (!existsSync(sourceFullPath)) {
        return toErrorResponse(operation, "SOURCE_FILE_NOT_FOUND", "Source file does not exist");
      }

      const sourceStats = await stat(sourceFullPath);
      if (!sourceStats.isFile()) {
        return toErrorResponse(operation, "SOURCE_NOT_FILE", "Source path is not a file");
      }

      const destinationExists = existsSync(destinationFullPath);
      if (destinationExists) {
        const destinationStats = await stat(destinationFullPath);
        if (destinationStats.isDirectory()) {
          return toErrorResponse(operation, "DESTINATION_IS_DIRECTORY", "Destination path points to a directory");
        }

        if (!overwrite) {
          return toErrorResponse(operation, "DESTINATION_EXISTS", "Destination file already exists");
        }

        await unlink(destinationFullPath);
      }

      const destinationDir = dirname(destinationFullPath);
      if (!existsSync(destinationDir)) {
        await mkdir(destinationDir, { recursive: true });
      }

      try {
        await copyFileToDisk(sourceFullPath, destinationFullPath);
      } catch {
        return toErrorResponse(operation, "COPY_FAILED", "Failed to copy file");
      }

      return toSuccessResponse(operation, {
        source_path: normalizeRelativePath(source_path),
        destination_path: normalizeRelativePath(destination_path),
        overwritten: destinationExists && overwrite,
        copied: true,
      });
    },
  });
  tools.push(copyFileTool);

  // === MOVE FILE TOOL ===
  // Moves a file within the configured directory.
  const moveFileTool = tool({
    name: `move_file`,
    description: "Move a file to a new path within the configured directory.",
    parameters: {
      source_path: z
        .string()
        .min(1, "Source path cannot be empty")
        .refine((value) => value.trim().length > 0, "Source path cannot be empty"),
      destination_path: z
        .string()
        .min(1, "Destination path cannot be empty")
        .refine((value) => value.trim().length > 0, "Destination path cannot be empty"),
      overwrite: z.boolean().optional(),
    },
    implementation: async ({ source_path, destination_path, overwrite = false }) => {
      console.log("move_file tool called with parameters:", { source_path, destination_path, overwrite });
      const operation = "move_file";
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");

      if (!folderName || !existsSync(folderName)) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }

      const sourceFullPath = join(folderName, source_path);
      const destinationFullPath = join(folderName, destination_path);

      if (!isPathWithinBaseDir(folderName, sourceFullPath)) {
        return toErrorResponse(operation, "SOURCE_PATH_OUTSIDE_BASE", "Source path is outside the configured directory.");
      }

      if (!isPathWithinBaseDir(folderName, destinationFullPath)) {
        return toErrorResponse(operation, "DESTINATION_PATH_OUTSIDE_BASE", "Destination path is outside the configured directory.");
      }

      if (resolve(sourceFullPath) === resolve(destinationFullPath)) {
        return toErrorResponse(operation, "SOURCE_EQUALS_DESTINATION", "Source and destination paths must be different.");
      }

      if (!existsSync(sourceFullPath)) {
        return toErrorResponse(operation, "SOURCE_FILE_NOT_FOUND", "Source file does not exist");
      }

      const sourceStats = await stat(sourceFullPath);
      if (!sourceStats.isFile()) {
        return toErrorResponse(operation, "SOURCE_NOT_FILE", "Source path is not a file");
      }

      const destinationExists = existsSync(destinationFullPath);
      if (destinationExists) {
        const destinationStats = await stat(destinationFullPath);
        if (destinationStats.isDirectory()) {
          return toErrorResponse(operation, "DESTINATION_IS_DIRECTORY", "Destination path points to a directory");
        }

        if (!overwrite) {
          return toErrorResponse(operation, "DESTINATION_EXISTS", "Destination file already exists");
        }

        await unlink(destinationFullPath);
      }

      const destinationDir = dirname(destinationFullPath);
      if (!existsSync(destinationDir)) {
        await mkdir(destinationDir, { recursive: true });
      }

      try {
        await rename(sourceFullPath, destinationFullPath);
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode === "EXDEV") {
          return toErrorResponse(operation, "CROSS_DEVICE_MOVE_UNSUPPORTED", "Cannot move file across different filesystems");
        }

        return toErrorResponse(operation, "MOVE_FAILED", "Failed to move file");
      }

      return toSuccessResponse(operation, {
        source_path: normalizeRelativePath(source_path),
        destination_path: normalizeRelativePath(destination_path),
        moved: true,
        overwritten: destinationExists && overwrite,
      });
    },
  });
  tools.push(moveFileTool);

  // ===================
  // DIRECTORY TOOLS
  // ===================

  // === CREATE DIRECTORY TOOL ===
  // Creates a subdirectory within the configured directory
  const createDirectoryTool = tool({
    name: `create_directory`,
    description: "Create a new subdirectory within the configured directory.",
    parameters: {
      directory_name: z
        .string()
        .min(1, "Directory name cannot be empty")
        .refine((value) => value.trim().length > 0, "Directory name cannot be empty")
    },
    implementation: async ({ directory_name }) => {
      console.log("create_directory tool called with parameters:", { directory_name });
      const operation = "create_directory";
      // Check if directory is set
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");
      if (!folderName) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }

      // Validate that the directory path is within the configured directory
      const fullPath = join(folderName, directory_name);

      // Security check: ensure the path is within the configured directory
      if (!isPathWithinBaseDir(folderName, fullPath)) {
        return toErrorResponse(operation, "DIRECTORY_PATH_OUTSIDE_BASE", "Directory path is outside the configured directory.");
      }

      const directoryAlreadyExists = existsSync(fullPath);

      // Create directory
      await mkdir(fullPath, { recursive: true });

      return toSuccessResponse(operation, {
        directory_name: basename(directory_name),
        relative_path: normalizeRelativePath(directory_name),
        created: !directoryAlreadyExists,
      });
    },
  });
  tools.push(createDirectoryTool);

  // === DELETE DIRECTORY TOOL ===
  // Deletes a directory within the configured directory.
  const deleteDirectoryTool = tool({
    name: `delete_directory`,
    description: "Delete a directory from the configured directory.",
    parameters: {
      directory_path: z
        .string()
        .min(1, "Directory path cannot be empty")
        .refine((value) => value.trim().length > 0, "Directory path cannot be empty"),
      recursive: z.boolean().optional(),
    },
    implementation: async ({ directory_path, recursive = false }) => {
      console.log("delete_directory tool called with parameters:", { directory_path, recursive });
      const operation = "delete_directory";
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");

      if (!folderName || !existsSync(folderName)) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }

      const fullPath = join(folderName, directory_path);
      if (!isPathWithinBaseDir(folderName, fullPath)) {
        return toErrorResponse(operation, "DIRECTORY_PATH_OUTSIDE_BASE", "Directory path is outside the configured directory.");
      }

      if (!existsSync(fullPath)) {
        return toErrorResponse(operation, "DIRECTORY_NOT_FOUND", "Directory does not exist");
      }

      const pathStats = await stat(fullPath);
      if (!pathStats.isDirectory()) {
        return toErrorResponse(operation, "DIRECTORY_NOT_DIRECTORY", "Path is not a directory");
      }

      try {
        if (recursive) {
          await rm(fullPath, { recursive: true, force: false });
        } else {
          await rmdir(fullPath);
        }
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode === "ENOTEMPTY" || errorCode === "EEXIST") {
          return toErrorResponse(operation, "DIRECTORY_NOT_EMPTY", "Directory is not empty; set recursive to true to delete it");
        }

        return toErrorResponse(operation, "DELETE_FAILED", "Failed to delete directory");
      }

      return toSuccessResponse(operation, {
        directory_name: basename(directory_path),
        relative_path: normalizeRelativePath(directory_path),
        deleted: true,
        recursive,
      });
    },
  });
  tools.push(deleteDirectoryTool);

  // === COPY DIRECTORY TOOL ===
  // Copies a directory within the configured directory.
  const copyDirectoryTool = tool({
    name: `copy_directory`,
    description: "Copy a directory to a new path within the configured directory.",
    parameters: {
      source_path: z
        .string()
        .min(1, "Source path cannot be empty")
        .refine((value) => value.trim().length > 0, "Source path cannot be empty"),
      destination_path: z
        .string()
        .min(1, "Destination path cannot be empty")
        .refine((value) => value.trim().length > 0, "Destination path cannot be empty"),
      overwrite: z.boolean().optional(),
    },
    implementation: async ({ source_path, destination_path, overwrite = false }) => {
      console.log("copy_directory tool called with parameters:", { source_path, destination_path, overwrite });
      const operation = "copy_directory";
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");

      if (!folderName || !existsSync(folderName)) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }

      const sourceFullPath = join(folderName, source_path);
      const destinationFullPath = join(folderName, destination_path);

      if (!isPathWithinBaseDir(folderName, sourceFullPath)) {
        return toErrorResponse(operation, "SOURCE_PATH_OUTSIDE_BASE", "Source path is outside the configured directory.");
      }

      if (!isPathWithinBaseDir(folderName, destinationFullPath)) {
        return toErrorResponse(operation, "DESTINATION_PATH_OUTSIDE_BASE", "Destination path is outside the configured directory.");
      }

      const resolvedSourcePath = resolve(sourceFullPath);
      const resolvedDestinationPath = resolve(destinationFullPath);
      if (resolvedSourcePath === resolvedDestinationPath) {
        return toErrorResponse(operation, "SOURCE_EQUALS_DESTINATION", "Source and destination paths must be different.");
      }

      const normalizedSourceDir = resolvedSourcePath.endsWith(sep) ? resolvedSourcePath : resolvedSourcePath + sep;
      if (resolvedDestinationPath.startsWith(normalizedSourceDir)) {
        return toErrorResponse(operation, "DESTINATION_INSIDE_SOURCE", "Destination cannot be inside the source directory.");
      }

      if (!existsSync(sourceFullPath)) {
        return toErrorResponse(operation, "SOURCE_DIRECTORY_NOT_FOUND", "Source directory does not exist");
      }

      const sourceStats = await stat(sourceFullPath);
      if (!sourceStats.isDirectory()) {
        return toErrorResponse(operation, "SOURCE_NOT_DIRECTORY", "Source path is not a directory");
      }

      const destinationExists = existsSync(destinationFullPath);
      if (destinationExists) {
        const destinationStats = await stat(destinationFullPath);
        if (!destinationStats.isDirectory()) {
          return toErrorResponse(operation, "DESTINATION_NOT_DIRECTORY", "Destination path points to a file");
        }

        if (!overwrite) {
          return toErrorResponse(operation, "DESTINATION_EXISTS", "Destination directory already exists");
        }

        await rm(destinationFullPath, { recursive: true, force: true });
      }

      const destinationParentDir = dirname(destinationFullPath);
      if (!existsSync(destinationParentDir)) {
        await mkdir(destinationParentDir, { recursive: true });
      }

      try {
        await copyDirectoryToDisk(sourceFullPath, destinationFullPath, { recursive: true, force: false });
      } catch {
        return toErrorResponse(operation, "COPY_FAILED", "Failed to copy directory");
      }

      return toSuccessResponse(operation, {
        source_path: normalizeRelativePath(source_path),
        destination_path: normalizeRelativePath(destination_path),
        overwritten: destinationExists && overwrite,
        copied: true,
      });
    },
  });
  tools.push(copyDirectoryTool);

  // === MOVE DIRECTORY TOOL ===
  // Moves a directory within the configured directory.
  const moveDirectoryTool = tool({
    name: `move_directory`,
    description: "Move a directory to a new path within the configured directory.",
    parameters: {
      source_path: z
        .string()
        .min(1, "Source path cannot be empty")
        .refine((value) => value.trim().length > 0, "Source path cannot be empty"),
      destination_path: z
        .string()
        .min(1, "Destination path cannot be empty")
        .refine((value) => value.trim().length > 0, "Destination path cannot be empty"),
      overwrite: z.boolean().optional(),
    },
    implementation: async ({ source_path, destination_path, overwrite = false }) => {
      console.log("move_directory tool called with parameters:", { source_path, destination_path, overwrite });
      const operation = "move_directory";
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");

      if (!folderName || !existsSync(folderName)) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }

      const sourceFullPath = join(folderName, source_path);
      const destinationFullPath = join(folderName, destination_path);

      if (!isPathWithinBaseDir(folderName, sourceFullPath)) {
        return toErrorResponse(operation, "SOURCE_PATH_OUTSIDE_BASE", "Source path is outside the configured directory.");
      }

      if (!isPathWithinBaseDir(folderName, destinationFullPath)) {
        return toErrorResponse(operation, "DESTINATION_PATH_OUTSIDE_BASE", "Destination path is outside the configured directory.");
      }

      const resolvedSourcePath = resolve(sourceFullPath);
      const resolvedDestinationPath = resolve(destinationFullPath);
      if (resolvedSourcePath === resolvedDestinationPath) {
        return toErrorResponse(operation, "SOURCE_EQUALS_DESTINATION", "Source and destination paths must be different.");
      }

      const normalizedSourceDir = resolvedSourcePath.endsWith(sep) ? resolvedSourcePath : resolvedSourcePath + sep;
      if (resolvedDestinationPath.startsWith(normalizedSourceDir)) {
        return toErrorResponse(operation, "DESTINATION_INSIDE_SOURCE", "Destination cannot be inside the source directory.");
      }

      if (!existsSync(sourceFullPath)) {
        return toErrorResponse(operation, "SOURCE_DIRECTORY_NOT_FOUND", "Source directory does not exist");
      }

      const sourceStats = await stat(sourceFullPath);
      if (!sourceStats.isDirectory()) {
        return toErrorResponse(operation, "SOURCE_NOT_DIRECTORY", "Source path is not a directory");
      }

      const destinationExists = existsSync(destinationFullPath);
      if (destinationExists) {
        const destinationStats = await stat(destinationFullPath);
        if (!destinationStats.isDirectory()) {
          return toErrorResponse(operation, "DESTINATION_NOT_DIRECTORY", "Destination path points to a file");
        }

        if (!overwrite) {
          return toErrorResponse(operation, "DESTINATION_EXISTS", "Destination directory already exists");
        }

        await rm(destinationFullPath, { recursive: true, force: true });
      }

      const destinationParentDir = dirname(destinationFullPath);
      if (!existsSync(destinationParentDir)) {
        await mkdir(destinationParentDir, { recursive: true });
      }

      try {
        await rename(sourceFullPath, destinationFullPath);
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode === "EXDEV") {
          return toErrorResponse(operation, "CROSS_DEVICE_MOVE_UNSUPPORTED", "Cannot move directory across different filesystems");
        }

        return toErrorResponse(operation, "MOVE_FAILED", "Failed to move directory");
      }

      return toSuccessResponse(operation, {
        source_path: normalizeRelativePath(source_path),
        destination_path: normalizeRelativePath(destination_path),
        moved: true,
        overwritten: destinationExists && overwrite,
      });
    },
  });
  tools.push(moveDirectoryTool);

  // === LIST FILES TOOL ===
  // Lists all files in the configured directory, optionally recursively
  const listFilesTool = tool({
    name: `list_files`,
    description: "List files in the configured directory. Set recursive to true (default) to include files in all subdirectories; set to false for a shallow listing of the root directory only. Returns relative paths.",
    parameters: {
      recursive: z.boolean().optional(),
    },
    implementation: async ({ recursive = true }) => {
      console.log("list_files tool called with parameters:", { recursive });
      const operation = "list_files";
      // Check if directory is set
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");
      if (!folderName || !existsSync(folderName)) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }

      try {
        let files: string[];
        if (recursive) {
          // Get file list recursively
          files = (await collectRelativeFilesRecursive(folderName)).sort((a, b) => a.localeCompare(b));
        } else {
          // Get shallow file list (root only)
          const entries = await readdir(folderName, { withFileTypes: true });
          files = entries
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
        }
        return toSuccessResponse(operation, {
          count: files.length,
          recursive,
          files,
        });
      } catch {
        return toErrorResponse(operation, "LIST_FAILED", "Failed to list files");
      }
    },
  });
  tools.push(listFilesTool);

  // ================
  // UTILITY TOOLS
  // ================

  // === PATH EXISTS TOOL ===
  // Checks whether a path exists in the configured directory.
  const pathExistsTool = tool({
    name: `path_exists`,
    description: "Check whether a path exists in the configured directory.",
    parameters: {
      path: z
        .string()
        .min(1, "Path cannot be empty")
        .refine((value) => value.trim().length > 0, "Path cannot be empty"),
    },
    implementation: async ({ path }) => {
      console.log("path_exists tool called with parameters:", { path });
      const operation = "path_exists";
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");

      if (!folderName || !existsSync(folderName)) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }

      const fullPath = join(folderName, path);
      if (!isPathWithinBaseDir(folderName, fullPath)) {
        return toErrorResponse(operation, "PATH_OUTSIDE_BASE", "Path is outside the configured directory.");
      }

      if (!existsSync(fullPath)) {
        return toSuccessResponse(operation, {
          path: normalizeRelativePath(path),
          exists: false,
          path_type: "missing",
        });
      }

      const pathStats = await stat(fullPath);
      const pathType = pathStats.isDirectory() ? "directory" : "file";

      return toSuccessResponse(operation, {
        path: normalizeRelativePath(path),
        exists: true,
        path_type: pathType,
      });
    },
  });
  tools.push(pathExistsTool);

  // === FIND FILE TOOL ===
  // Recursively finds files by exact filename first, then a lax pattern fallback.
  const findFileTool = tool({
    name: `find_file`,
    description: "Recursively search for files in the configured directory. Tries exact filename first, then a lax match if nothing is found.",
    parameters: {
      file_name: z
        .string()
        .min(1, "File name cannot be empty")
        .refine((value) => value.trim().length > 0, "File name cannot be empty"),
    },
    implementation: async ({ file_name }) => {
      console.log("find_file tool called with parameters:", { file_name });
      const operation = "find_file";

      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");
      if (!folderName || !existsSync(folderName)) {
        return toErrorResponse(operation, "DIR_NOT_AVAILABLE", "Directory not set or does not exist");
      }

      const allFiles = (await collectRelativeFilesRecursive(folderName)).sort((a, b) => a.localeCompare(b));

      if (allFiles.length === 0) {
        return toSuccessResponse(operation, {
          query: file_name,
          match_type: "none",
          count: 0,
          matches: [],
        });
      }

      const normalizedQuery = basename(file_name).toLowerCase();
      const exactMatches = allFiles.filter((path) => basename(path).toLowerCase() === normalizedQuery);

      if (exactMatches.length > 0) {
        const matches: SearchMatch[] = exactMatches
          .map((path) => ({
            file_name: basename(path),
            relative_path: path,
            score: 1,
          }))
          .sort((a, b) => a.relative_path.localeCompare(b.relative_path));

        return toSuccessResponse(operation, {
          query: file_name,
          match_type: "exact",
          count: matches.length,
          matches,
        });
      }

      const tokens = tokenizeSearchQuery(file_name);
      const laxRegex = buildLaxSearchRegex(tokens);
      const laxMatches: SearchMatch[] = allFiles
        .map((path) => {
          const fileBaseName = basename(path);
          if (!laxRegex.test(fileBaseName)) {
            return null;
          }

          const score = scoreLaxMatch(fileBaseName, tokens);
          if (score <= 0) {
            return null;
          }

          return {
            file_name: fileBaseName,
            relative_path: path,
            score,
          };
        })
        .filter((match): match is SearchMatch => match !== null)
        .sort((a, b) => {
          if (b.score !== a.score) {
            return b.score - a.score;
          }
          return a.relative_path.localeCompare(b.relative_path);
        });

      if (laxMatches.length === 0) {
        return toSuccessResponse(operation, {
          query: file_name,
          match_type: "none",
          count: 0,
          matches: [],
        });
      }

      return toSuccessResponse(operation, {
        query: file_name,
        match_type: "lax",
        count: laxMatches.length,
        matches: laxMatches,
      });
    },
  });
  tools.push(findFileTool);

  return tools;
}
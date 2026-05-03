import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { existsSync } from "fs";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join, basename, dirname, resolve, sep } from "path";
import { z } from "zod";
import { configSchematics } from "./config";

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

function buildLaxSearchRegex(query: string): RegExp {
  const tokens = query
    .trim()
    .split(/[\s._-]+/)
    .filter((token) => token.length > 0)
    .map((token) => escapeRegExp(token));

  if (tokens.length === 0) {
    return /^$/;
  }

  return new RegExp(tokens.join(".*"), "i");
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
      files.push(relativePath.split(sep).join("/"));
    }
  }

  return files;
}

function formatMatches(matches: string[]): string {
  if (matches.length === 1) {
    const [path] = matches;
    return `File found:\n- file_name: ${basename(path)} | relative_path: ${path}`;
  }

  return `Files found (${matches.length}):\n${matches
    .map((path) => `- file_name: ${basename(path)} | relative_path: ${path}`)
    .join("\n")}`;
}

export async function toolsProvider(ctl: ToolsProviderController) {
  const tools: Tool[] = [];

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
      // Check if directory is set
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");
      if (!folderName) {
        return "Error: Directory not set. Use set_directory first.";
      }

      // Validate that the file path is within the configured directory
      const fullPath = join(folderName, file_name);

      // Security check: ensure the path is within the configured directory
      // Allow paths with "/" in filenames (subdirectories) but prevent traversal outside the folder
      if (!isPathWithinBaseDir(folderName, fullPath)) {
        return "Error: File path is outside the configured directory.";
      }
      
      // Create directory structure if needed
      const fileDir = dirname(fullPath);
      if (!existsSync(fileDir)) {
        await mkdir(fileDir, { recursive: true });
      }
      
      // Write file (creates or overwrites)
      await writeFile(fullPath, content, "utf-8");
      
      return "File created or updated successfully";
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
      // Check if directory is set
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");
      if (!folderName) {
        return "Error: Directory not set. Use set_directory first.";
      }
      
      // Validate that the file path is within the configured directory
      const fullPath = join(folderName, file_name);

      // Security check: ensure the path is within the configured directory
      if (!isPathWithinBaseDir(folderName, fullPath)) {
        return "Error: File path is outside the configured directory.";
      }

      // Build file path
      const filePath = fullPath;
      
      // Check if file exists
      if (!existsSync(filePath)) {
        return "Error: File does not exist";
      }
      
      // Read and return content
      return await readFile(filePath, "utf-8");
    },
  });
  tools.push(readFileTool);

  // === LIST FILES TOOL ===
  // Lists all files in the configured directory
  const listFilesTool = tool({
    name: `list_files`,
    description: "List all files in the configured directory.",
    parameters: {},
    implementation: async () => {
      console.log("list_files tool called");
      // Check if directory is set
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");
      if (!folderName || !existsSync(folderName)) {
        return "Error: Directory not set or does not exist";
      }

      // Get file list
      const files = await readdir(folderName);

      if (files.length === 0) {
        return "Directory is empty";
      }
      
      return `Files found:\n${files.map(f => `- ${f}`).join("\n")}`;
    },
  });
  tools.push(listFilesTool);

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

      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");
      if (!folderName || !existsSync(folderName)) {
        return "Error: Directory not set or does not exist";
      }

      const allFiles = (await collectRelativeFilesRecursive(folderName)).sort((a, b) => a.localeCompare(b));

      if (allFiles.length === 0) {
        return "Directory is empty";
      }

      const normalizedQuery = basename(file_name).toLowerCase();
      const exactMatches = allFiles.filter((path) => basename(path).toLowerCase() === normalizedQuery);

      if (exactMatches.length > 0) {
        return `Exact filename matches:\n${formatMatches(exactMatches)}`;
      }

      const laxRegex = buildLaxSearchRegex(file_name);
      const laxMatches = allFiles.filter((path) => {
        const fileBaseName = basename(path);
        return laxRegex.test(fileBaseName);
      });


      if (laxMatches.length === 0) {
        return `No files found matching '${file_name}'.`;
      }

      return `No exact filename matches found. Similar matches:\n${formatMatches(laxMatches)}`;
    },
  });
  tools.push(findFileTool);

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
      // Check if directory is set
      const folderName = ctl.getPluginConfig(configSchematics).get("folderName");
      if (!folderName) {
        return "Error: Directory not set. Use set_directory first.";
      }
      
      // Validate that the directory path is within the configured directory
      const fullPath = join(folderName, directory_name);

      // Security check: ensure the path is within the configured directory
      if (!isPathWithinBaseDir(folderName, fullPath)) {
        return "Error: Directory path is outside the configured directory.";
      }
      
      // Create directory
      await mkdir(fullPath, { recursive: true });
      
      return `Directory '${directory_name}' created successfully`;
    },
  });
  tools.push(createDirectoryTool);

  return tools;
}
import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { existsSync, statSync } from "fs";
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

export async function toolsProvider(ctl: ToolsProviderController) {
  const tools: Tool[] = [];

  // === WRITE FILE TOOL ===
  // Writes files to the configured directory
  const writeFileTool = tool({
    name: `write_file`,
    description: "Write or update a file with the given name and content. Creates the file if it doesn't exist. Supports subdirectories.",
    parameters: {
      file_name: z.string().min(1, "File name cannot be empty").regex(/^[\w./-]+$/, "File name can only contain letters, numbers, underscores, hyphens, dots, and forward slashes"),
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
      file_name: z.string().min(1, "File name cannot be empty").regex(/^[\w./-]+$/, "File name can only contain letters, numbers, underscores, hyphens, dots, and forward slashes")
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

  // === CREATE DIRECTORY TOOL ===
  // Creates a subdirectory within the configured directory
  const createDirectoryTool = tool({
    name: `create_directory`,
    description: "Create a new subdirectory within the configured directory.",
    parameters: {
      directory_name: z.string().min(1, "Directory name cannot be empty").regex(/^[\w./-]+$/, "Directory name can only contain letters, numbers, underscores, hyphens, dots, and forward slashes")
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
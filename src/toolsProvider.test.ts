import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile as writeFileToDisk } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock SDK helpers so tool() returns a test-friendly object and config schematics can be created.
vi.mock("@lmstudio/sdk", () => ({
  tool: (definition: unknown) => definition,
  createConfigSchematics: () => {
    const chain = {
      field: () => chain,
      build: () => ({ mocked: true }),
    };
    return chain;
  },
}));

import { toolsProvider } from "./toolsProvider";

type ToolDefinition = {
  name: string;
  implementation: (...args: unknown[]) => Promise<string>;
};

type MockCtl = {
  getPluginConfig: () => {
    get: (key: string) => string | undefined;
  };
};

function createCtl(folderName?: string): MockCtl {
  return {
    getPluginConfig: () => ({
      get: (key: string) => (key === "folderName" ? folderName : undefined),
    }),
  };
}

async function getTool(folderName: string | undefined, name: string): Promise<ToolDefinition> {
  const tools = (await toolsProvider(createCtl(folderName) as never)) as unknown as ToolDefinition[];
  const target = tools.find((tool) => tool.name === name);

  if (!target) {
    throw new Error(`Tool not found: ${name}`);
  }

  return target;
}

describe("toolsProvider", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "tools-provider-test-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("allows a user to save and open a file in the selected folder", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const readTool = await getTool(baseDir, "read_file");

    const writeResult = await writeTool.implementation({
      file_name: "notes/today.txt",
      content: "hello from test",
    });

    expect(writeResult).toBe("File created or updated successfully");

    const content = await readTool.implementation({
      file_name: "notes/today.txt",
    });

    expect(content).toBe("hello from test");
  });

  it("allows write_file and read_file to use spaces and special characters in filenames", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const readTool = await getTool(baseDir, "read_file");
    const fileName = "notes/Annual Report (Final) [v2].txt";

    const writeResult = await writeTool.implementation({
      file_name: fileName,
      content: "content with spaces in file name",
    });

    expect(writeResult).toBe("File created or updated successfully");

    const readResult = await readTool.implementation({
      file_name: fileName,
    });

    expect(readResult).toBe("content with spaces in file name");
  });

  it("prevents a user from accessing files outside the selected folder", async () => {
    const writeTool = await getTool(baseDir, "write_file");

    const result = await writeTool.implementation({
      file_name: "../outside.txt",
      content: "should not be written",
    });

    expect(result).toBe("Error: File path is outside the configured directory.");
    expect(existsSync(join(baseDir, "../outside.txt"))).toBe(false);
  });

  it("lets a user create nested folders in the selected folder", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");

    const result = await createDirectoryTool.implementation({
      directory_name: "a/b/c",
    });

    expect(result).toBe("Directory 'a/b/c' created successfully");
    expect(existsSync(join(baseDir, "a/b/c"))).toBe(true);
  });

  it("allows create_directory to use spaces and special characters", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");

    const result = await createDirectoryTool.implementation({
      directory_name: "planning/Team Notes (Q2) [Draft]",
    });

    expect(result).toBe("Directory 'planning/Team Notes (Q2) [Draft]' created successfully");
    expect(existsSync(join(baseDir, "planning/Team Notes (Q2) [Draft]"))).toBe(true);
  });

  it("prevents create_directory from escaping the selected folder", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");

    const result = await createDirectoryTool.implementation({
      directory_name: "../outside-folder",
    });

    expect(result).toBe("Error: Directory path is outside the configured directory.");
    expect(existsSync(join(baseDir, "../outside-folder"))).toBe(false);
  });

  it("shows a user the files in the selected folder", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const listFilesTool = await getTool(baseDir, "list_files");

    await writeTool.implementation({ file_name: "first.txt", content: "1" });
    await writeTool.implementation({ file_name: "second.txt", content: "2" });

    const result = await listFilesTool.implementation();

    expect(result).toContain("Files found:");
    expect(result).toContain("- first.txt");
    expect(result).toContain("- second.txt");
  });

  it("finds a file by exact name recursively and returns a relative path", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const findFileTool = await getTool(baseDir, "find_file");

    await writeTool.implementation({ file_name: "docs/archive/report.md", content: "v1" });

    const result = await findFileTool.implementation({ file_name: "report.md" });

    expect(result).toContain("Exact filename matches:");
    expect(result).toContain("file_name: report.md");
    expect(result).toContain("relative_path: docs/archive/report.md");
  });

  it("returns full relative paths when multiple files share the same name", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const findFileTool = await getTool(baseDir, "find_file");

    await writeTool.implementation({ file_name: "a/report.md", content: "a" });
    await writeTool.implementation({ file_name: "b/report.md", content: "b" });

    const result = await findFileTool.implementation({ file_name: "report.md" });

    expect(result).toContain("Files found (2):");
    expect(result).toContain("file_name: report.md");
    expect(result).toContain("relative_path: a/report.md");
    expect(result).toContain("relative_path: b/report.md");
  });

  it("falls back to lax matching when exact filename is not found", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const findFileTool = await getTool(baseDir, "find_file");

    await writeTool.implementation({ file_name: "notes/report-final-2026.md", content: "final" });

    const result = await findFileTool.implementation({ file_name: "report_2026" });

    expect(result).toContain("No exact filename matches found. Similar matches:");
    expect(result).toContain("file_name: report-final-2026.md");
    expect(result).toContain("relative_path: notes/report-final-2026.md");
  });

  it("does not return results when only a directory name matches", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const findFileTool = await getTool(baseDir, "find_file");

    await writeTool.implementation({ file_name: "projects-2026/summary.md", content: "summary" });

    const result = await findFileTool.implementation({ file_name: "projects-2026" });

    expect(result).toBe("No files found matching 'projects-2026'.");
  });

  it("returns a clear message when no file matches", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const findFileTool = await getTool(baseDir, "find_file");

    await writeTool.implementation({ file_name: "present.txt", content: "here" });

    const result = await findFileTool.implementation({ file_name: "missing-file.txt" });

    expect(result).toBe("No files found matching 'missing-file.txt'.");
  });

  it("supports spaces and special characters in find_file queries", async () => {
    const findFileTool = await getTool(baseDir, "find_file");
    const docsDir = join(baseDir, "docs");
    const filename = "Annual Report (Final) [v2].md";

    await mkdir(docsDir, { recursive: true });
    await writeFileToDisk(join(docsDir, filename), "report", "utf-8");

    const result = await findFileTool.implementation({ file_name: filename });

    expect(result).toContain("Exact filename matches:");
    expect(result).toContain("file_name: Annual Report (Final) [v2].md");
    expect(result).toContain("relative_path: docs/Annual Report (Final) [v2].md");
  });

  it("tells a user to set a folder before reading files", async () => {
    const readTool = await getTool(undefined, "read_file");

    const result = await readTool.implementation({ file_name: "missing.txt" });

    expect(result).toBe("Error: Directory not set. Use set_directory first.");
  });

  it("tells a user when the requested file does not exist", async () => {
    const readTool = await getTool(baseDir, "read_file");

    const result = await readTool.implementation({ file_name: "does-not-exist.txt" });

    expect(result).toBe("Error: File does not exist");
  });

  it("saves exactly the content a user provides", async () => {
    const writeTool = await getTool(baseDir, "write_file");

    await writeTool.implementation({
      file_name: "raw.txt",
      content: "disk check",
    });

    const diskContent = await readFile(join(baseDir, "raw.txt"), "utf-8");
    expect(diskContent).toBe("disk check");
  });
});


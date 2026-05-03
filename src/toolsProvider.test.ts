import { existsSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
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


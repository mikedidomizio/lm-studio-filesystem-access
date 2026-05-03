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

type ToolResponse<T = unknown> =
  | {
      ok: true;
      operation: string;
      data: T;
    }
  | {
      ok: false;
      operation: string;
      error: {
        code: string;
        message: string;
      };
    };

function parseResponse<T = unknown>(raw: string): ToolResponse<T> {
  return JSON.parse(raw) as ToolResponse<T>;
}

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

    const writeRaw = await writeTool.implementation({
      file_name: "notes/today.txt",
      content: "hello from test",
    });
    const writeResult = parseResponse<{
      file_name: string;
      relative_path: string;
      created: boolean;
      updated: boolean;
    }>(writeRaw);

    expect(writeResult.ok).toBe(true);
    if (writeResult.ok) {
      expect(writeResult.operation).toBe("write_file");
      expect(writeResult.data).toEqual({
        file_name: "today.txt",
        relative_path: "notes/today.txt",
        created: true,
        updated: false,
      });
    }

    const readRaw = await readTool.implementation({
      file_name: "notes/today.txt",
    });
    const readResult = parseResponse<{ content: string }>(readRaw);

    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.operation).toBe("read_file");
      expect(readResult.data.content).toBe("hello from test");
    }
  });

  it("allows write_file and read_file to use spaces and special characters in filenames", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const readTool = await getTool(baseDir, "read_file");
    const fileName = "notes/Annual Report (Final) [v2].txt";

    const writeRaw = await writeTool.implementation({
      file_name: fileName,
      content: "content with spaces in file name",
    });
    const writeResult = parseResponse(writeRaw);

    expect(writeResult.ok).toBe(true);

    const readRaw = await readTool.implementation({
      file_name: fileName,
    });
    const readResult = parseResponse<{ content: string }>(readRaw);

    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.data.content).toBe("content with spaces in file name");
    }
  });

  it("prevents a user from accessing files outside the selected folder", async () => {
    const writeTool = await getTool(baseDir, "write_file");

    const raw = await writeTool.implementation({
      file_name: "../outside.txt",
      content: "should not be written",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "write_file",
      error: {
        code: "FILE_PATH_OUTSIDE_BASE",
        message: "File path is outside the configured directory.",
      },
    });
    expect(existsSync(join(baseDir, "../outside.txt"))).toBe(false);
  });

  it("lets a user create nested folders in the selected folder", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");

    const raw = await createDirectoryTool.implementation({
      directory_name: "a/b/c",
    });
    const result = parseResponse(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operation).toBe("create_directory");
      expect(result.data).toEqual({
        directory_name: "c",
        relative_path: "a/b/c",
        created: true,
      });
    }
    expect(existsSync(join(baseDir, "a/b/c"))).toBe(true);
  });

  it("allows create_directory to use spaces and special characters", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");

    const raw = await createDirectoryTool.implementation({
      directory_name: "planning/Team Notes (Q2) [Draft]",
    });
    const result = parseResponse(raw);

    expect(result.ok).toBe(true);
    expect(existsSync(join(baseDir, "planning/Team Notes (Q2) [Draft]"))).toBe(true);
  });

  it("prevents create_directory from escaping the selected folder", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");

    const raw = await createDirectoryTool.implementation({
      directory_name: "../outside-folder",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "create_directory",
      error: {
        code: "DIRECTORY_PATH_OUTSIDE_BASE",
        message: "Directory path is outside the configured directory.",
      },
    });
    expect(existsSync(join(baseDir, "../outside-folder"))).toBe(false);
  });

  it("shows a user the files in the selected folder", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const listFilesTool = await getTool(baseDir, "list_files");

    await writeTool.implementation({ file_name: "first.txt", content: "1" });
    await writeTool.implementation({ file_name: "second.txt", content: "2" });

    const raw = await listFilesTool.implementation();
    const result = parseResponse<{ count: number; files: string[] }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operation).toBe("list_files");
      expect(result.data.count).toBe(2);
      expect(result.data.files).toEqual(["first.txt", "second.txt"]);
    }
  });

  it("reports an existing file with path_exists", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const pathExistsTool = await getTool(baseDir, "path_exists");

    await writeTool.implementation({ file_name: "notes/today.txt", content: "ok" });

    const raw = await pathExistsTool.implementation({ path: "notes/today.txt" });
    const result = parseResponse<{ path: string; exists: boolean; path_type: string }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operation).toBe("path_exists");
      expect(result.data).toEqual({
        path: "notes/today.txt",
        exists: true,
        path_type: "file",
      });
    }
  });

  it("reports an existing directory with path_exists", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");
    const pathExistsTool = await getTool(baseDir, "path_exists");

    await createDirectoryTool.implementation({ directory_name: "notes/archive" });

    const raw = await pathExistsTool.implementation({ path: "notes/archive" });
    const result = parseResponse<{ path: string; exists: boolean; path_type: string }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        path: "notes/archive",
        exists: true,
        path_type: "directory",
      });
    }
  });

  it("reports missing paths as exists false with path_exists", async () => {
    const pathExistsTool = await getTool(baseDir, "path_exists");

    const raw = await pathExistsTool.implementation({ path: "missing/file.txt" });
    const result = parseResponse<{ path: string; exists: boolean; path_type: string }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        path: "missing/file.txt",
        exists: false,
        path_type: "missing",
      });
    }
  });

  it("blocks path_exists when the path escapes the selected folder", async () => {
    const pathExistsTool = await getTool(baseDir, "path_exists");

    const raw = await pathExistsTool.implementation({ path: "../outside.txt" });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "path_exists",
      error: {
        code: "PATH_OUTSIDE_BASE",
        message: "Path is outside the configured directory.",
      },
    });
  });

  it("returns an error when path_exists is used without a configured directory", async () => {
    const pathExistsTool = await getTool(undefined, "path_exists");

    const raw = await pathExistsTool.implementation({ path: "somewhere.txt" });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "path_exists",
      error: {
        code: "DIR_NOT_AVAILABLE",
        message: "Directory not set or does not exist",
      },
    });
  });

  it("moves a file to a new path", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const moveFileTool = await getTool(baseDir, "move_file");

    await writeTool.implementation({ file_name: "drafts/todo.txt", content: "ship it" });

    const raw = await moveFileTool.implementation({
      source_path: "drafts/todo.txt",
      destination_path: "archive/todo.txt",
    });
    const result = parseResponse<{
      source_path: string;
      destination_path: string;
      overwritten: boolean;
    }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operation).toBe("move_file");
      expect(result.data).toEqual({
        source_path: "drafts/todo.txt",
        destination_path: "archive/todo.txt",
        overwritten: false,
      });
    }

    expect(existsSync(join(baseDir, "drafts/todo.txt"))).toBe(false);
    expect(await readFile(join(baseDir, "archive/todo.txt"), "utf-8")).toBe("ship it");
  });

  it("returns an error when move_file destination exists and overwrite is false", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const moveFileTool = await getTool(baseDir, "move_file");

    await writeTool.implementation({ file_name: "src/a.txt", content: "a" });
    await writeTool.implementation({ file_name: "dst/a.txt", content: "old" });

    const raw = await moveFileTool.implementation({
      source_path: "src/a.txt",
      destination_path: "dst/a.txt",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "move_file",
      error: {
        code: "DESTINATION_EXISTS",
        message: "Destination file already exists",
      },
    });
    expect(await readFile(join(baseDir, "src/a.txt"), "utf-8")).toBe("a");
    expect(await readFile(join(baseDir, "dst/a.txt"), "utf-8")).toBe("old");
  });

  it("overwrites destination when move_file overwrite is true", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const moveFileTool = await getTool(baseDir, "move_file");

    await writeTool.implementation({ file_name: "src/a.txt", content: "new" });
    await writeTool.implementation({ file_name: "dst/a.txt", content: "old" });

    const raw = await moveFileTool.implementation({
      source_path: "src/a.txt",
      destination_path: "dst/a.txt",
      overwrite: true,
    });
    const result = parseResponse<{ overwritten: boolean }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.overwritten).toBe(true);
    }
    expect(existsSync(join(baseDir, "src/a.txt"))).toBe(false);
    expect(await readFile(join(baseDir, "dst/a.txt"), "utf-8")).toBe("new");
  });

  it("blocks move_file when source path escapes the selected folder", async () => {
    const moveFileTool = await getTool(baseDir, "move_file");

    const raw = await moveFileTool.implementation({
      source_path: "../outside.txt",
      destination_path: "inside.txt",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "move_file",
      error: {
        code: "SOURCE_PATH_OUTSIDE_BASE",
        message: "Source path is outside the configured directory.",
      },
    });
  });

  it("returns an error when move_file source does not exist", async () => {
    const moveFileTool = await getTool(baseDir, "move_file");

    const raw = await moveFileTool.implementation({
      source_path: "missing.txt",
      destination_path: "archive/missing.txt",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "move_file",
      error: {
        code: "SOURCE_FILE_NOT_FOUND",
        message: "Source file does not exist",
      },
    });
  });

  it("copies a file to a new path", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const copyFileTool = await getTool(baseDir, "copy_file");

    await writeTool.implementation({ file_name: "src/file.txt", content: "copy me" });

    const raw = await copyFileTool.implementation({
      source_path: "src/file.txt",
      destination_path: "dst/file.txt",
    });
    const result = parseResponse<{
      source_path: string;
      destination_path: string;
      overwritten: boolean;
      copied: boolean;
    }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operation).toBe("copy_file");
      expect(result.data).toEqual({
        source_path: "src/file.txt",
        destination_path: "dst/file.txt",
        overwritten: false,
        copied: true,
      });
    }

    expect(await readFile(join(baseDir, "src/file.txt"), "utf-8")).toBe("copy me");
    expect(await readFile(join(baseDir, "dst/file.txt"), "utf-8")).toBe("copy me");
  });

  it("returns an error when copy_file destination exists and overwrite is false", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const copyFileTool = await getTool(baseDir, "copy_file");

    await writeTool.implementation({ file_name: "src/a.txt", content: "new" });
    await writeTool.implementation({ file_name: "dst/a.txt", content: "old" });

    const raw = await copyFileTool.implementation({
      source_path: "src/a.txt",
      destination_path: "dst/a.txt",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "copy_file",
      error: {
        code: "DESTINATION_EXISTS",
        message: "Destination file already exists",
      },
    });
    expect(await readFile(join(baseDir, "dst/a.txt"), "utf-8")).toBe("old");
  });

  it("overwrites destination when copy_file overwrite is true", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const copyFileTool = await getTool(baseDir, "copy_file");

    await writeTool.implementation({ file_name: "src/a.txt", content: "new" });
    await writeTool.implementation({ file_name: "dst/a.txt", content: "old" });

    const raw = await copyFileTool.implementation({
      source_path: "src/a.txt",
      destination_path: "dst/a.txt",
      overwrite: true,
    });
    const result = parseResponse<{ overwritten: boolean; copied: boolean }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.overwritten).toBe(true);
      expect(result.data.copied).toBe(true);
    }

    expect(await readFile(join(baseDir, "src/a.txt"), "utf-8")).toBe("new");
    expect(await readFile(join(baseDir, "dst/a.txt"), "utf-8")).toBe("new");
  });

  it("blocks copy_file when source path escapes the selected folder", async () => {
    const copyFileTool = await getTool(baseDir, "copy_file");

    const raw = await copyFileTool.implementation({
      source_path: "../outside.txt",
      destination_path: "inside.txt",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "copy_file",
      error: {
        code: "SOURCE_PATH_OUTSIDE_BASE",
        message: "Source path is outside the configured directory.",
      },
    });
  });

  it("returns an error when copy_file source does not exist", async () => {
    const copyFileTool = await getTool(baseDir, "copy_file");

    const raw = await copyFileTool.implementation({
      source_path: "missing.txt",
      destination_path: "archive/missing.txt",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "copy_file",
      error: {
        code: "SOURCE_FILE_NOT_FOUND",
        message: "Source file does not exist",
      },
    });
  });

  it("copies a directory to a new path", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const copyDirectoryTool = await getTool(baseDir, "copy_directory");

    await writeTool.implementation({ file_name: "docs/source/readme.md", content: "hello" });

    const raw = await copyDirectoryTool.implementation({
      source_path: "docs/source",
      destination_path: "docs/backup/source",
    });
    const result = parseResponse<{ source_path: string; destination_path: string; overwritten: boolean; copied: boolean }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operation).toBe("copy_directory");
      expect(result.data).toEqual({
        source_path: "docs/source",
        destination_path: "docs/backup/source",
        overwritten: false,
        copied: true,
      });
    }

    expect(await readFile(join(baseDir, "docs/source/readme.md"), "utf-8")).toBe("hello");
    expect(await readFile(join(baseDir, "docs/backup/source/readme.md"), "utf-8")).toBe("hello");
  });

  it("returns an error when copy_directory destination exists and overwrite is false", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");
    const copyDirectoryTool = await getTool(baseDir, "copy_directory");

    await createDirectoryTool.implementation({ directory_name: "a/src" });
    await createDirectoryTool.implementation({ directory_name: "a/dst" });

    const raw = await copyDirectoryTool.implementation({
      source_path: "a/src",
      destination_path: "a/dst",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "copy_directory",
      error: {
        code: "DESTINATION_EXISTS",
        message: "Destination directory already exists",
      },
    });
  });

  it("overwrites destination when copy_directory overwrite is true", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const copyDirectoryTool = await getTool(baseDir, "copy_directory");

    await writeTool.implementation({ file_name: "a/src/new.txt", content: "new" });
    await writeTool.implementation({ file_name: "a/dst/old.txt", content: "old" });

    const raw = await copyDirectoryTool.implementation({
      source_path: "a/src",
      destination_path: "a/dst",
      overwrite: true,
    });
    const result = parseResponse<{ overwritten: boolean; copied: boolean }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.overwritten).toBe(true);
      expect(result.data.copied).toBe(true);
    }

    expect(await readFile(join(baseDir, "a/src/new.txt"), "utf-8")).toBe("new");
    expect(await readFile(join(baseDir, "a/dst/new.txt"), "utf-8")).toBe("new");
    expect(existsSync(join(baseDir, "a/dst/old.txt"))).toBe(false);
  });

  it("blocks copy_directory when destination is inside source", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");
    const copyDirectoryTool = await getTool(baseDir, "copy_directory");

    await createDirectoryTool.implementation({ directory_name: "root/child" });

    const raw = await copyDirectoryTool.implementation({
      source_path: "root",
      destination_path: "root/child/new-root",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "copy_directory",
      error: {
        code: "DESTINATION_INSIDE_SOURCE",
        message: "Destination cannot be inside the source directory.",
      },
    });
  });

  it("returns an error when copy_directory source does not exist", async () => {
    const copyDirectoryTool = await getTool(baseDir, "copy_directory");

    const raw = await copyDirectoryTool.implementation({
      source_path: "missing-dir",
      destination_path: "archive/missing-dir",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "copy_directory",
      error: {
        code: "SOURCE_DIRECTORY_NOT_FOUND",
        message: "Source directory does not exist",
      },
    });
  });

  it("moves a directory to a new path", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const moveDirectoryTool = await getTool(baseDir, "move_directory");

    await writeTool.implementation({ file_name: "docs/source/readme.md", content: "hello" });

    const raw = await moveDirectoryTool.implementation({
      source_path: "docs/source",
      destination_path: "docs/archive/source",
    });
    const result = parseResponse<{ source_path: string; destination_path: string; overwritten: boolean }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operation).toBe("move_directory");
      expect(result.data).toEqual({
        source_path: "docs/source",
        destination_path: "docs/archive/source",
        overwritten: false,
      });
    }

    expect(existsSync(join(baseDir, "docs/source"))).toBe(false);
    expect(await readFile(join(baseDir, "docs/archive/source/readme.md"), "utf-8")).toBe("hello");
  });

  it("returns an error when move_directory destination exists and overwrite is false", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");
    const moveDirectoryTool = await getTool(baseDir, "move_directory");

    await createDirectoryTool.implementation({ directory_name: "a/src" });
    await createDirectoryTool.implementation({ directory_name: "a/dst" });

    const raw = await moveDirectoryTool.implementation({
      source_path: "a/src",
      destination_path: "a/dst",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "move_directory",
      error: {
        code: "DESTINATION_EXISTS",
        message: "Destination directory already exists",
      },
    });
  });

  it("overwrites destination when move_directory overwrite is true", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const moveDirectoryTool = await getTool(baseDir, "move_directory");

    await writeTool.implementation({ file_name: "a/src/new.txt", content: "new" });
    await writeTool.implementation({ file_name: "a/dst/old.txt", content: "old" });

    const raw = await moveDirectoryTool.implementation({
      source_path: "a/src",
      destination_path: "a/dst",
      overwrite: true,
    });
    const result = parseResponse<{ overwritten: boolean }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.overwritten).toBe(true);
    }

    expect(existsSync(join(baseDir, "a/src"))).toBe(false);
    expect(await readFile(join(baseDir, "a/dst/new.txt"), "utf-8")).toBe("new");
    expect(existsSync(join(baseDir, "a/dst/old.txt"))).toBe(false);
  });

  it("blocks move_directory when destination is inside source", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");
    const moveDirectoryTool = await getTool(baseDir, "move_directory");

    await createDirectoryTool.implementation({ directory_name: "root/child" });

    const raw = await moveDirectoryTool.implementation({
      source_path: "root",
      destination_path: "root/child/new-root",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "move_directory",
      error: {
        code: "DESTINATION_INSIDE_SOURCE",
        message: "Destination cannot be inside the source directory.",
      },
    });
  });

  it("blocks move_directory when source path escapes the selected folder", async () => {
    const moveDirectoryTool = await getTool(baseDir, "move_directory");

    const raw = await moveDirectoryTool.implementation({
      source_path: "../outside-dir",
      destination_path: "inside-dir",
    });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "move_directory",
      error: {
        code: "SOURCE_PATH_OUTSIDE_BASE",
        message: "Source path is outside the configured directory.",
      },
    });
  });

  it("deletes a file in the selected folder", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const deleteFileTool = await getTool(baseDir, "delete_file");

    await writeTool.implementation({ file_name: "trash/me.txt", content: "bye" });

    const raw = await deleteFileTool.implementation({ file_name: "trash/me.txt" });
    const result = parseResponse<{ file_name: string; relative_path: string; deleted: boolean }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operation).toBe("delete_file");
      expect(result.data).toEqual({
        file_name: "me.txt",
        relative_path: "trash/me.txt",
        deleted: true,
      });
    }
    expect(existsSync(join(baseDir, "trash/me.txt"))).toBe(false);
  });

  it("returns an error when delete_file does not exist", async () => {
    const deleteFileTool = await getTool(baseDir, "delete_file");

    const raw = await deleteFileTool.implementation({ file_name: "missing.txt" });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "delete_file",
      error: {
        code: "FILE_NOT_FOUND",
        message: "File does not exist",
      },
    });
  });

  it("blocks delete_file when file path escapes the selected folder", async () => {
    const deleteFileTool = await getTool(baseDir, "delete_file");

    const raw = await deleteFileTool.implementation({ file_name: "../outside.txt" });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "delete_file",
      error: {
        code: "FILE_PATH_OUTSIDE_BASE",
        message: "File path is outside the configured directory.",
      },
    });
  });

  it("returns an error when delete_file path points to a directory", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");
    const deleteFileTool = await getTool(baseDir, "delete_file");

    await createDirectoryTool.implementation({ directory_name: "trash-dir" });

    const raw = await deleteFileTool.implementation({ file_name: "trash-dir" });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "delete_file",
      error: {
        code: "FILE_NOT_FILE",
        message: "Path is not a file",
      },
    });
  });

  it("deletes an empty directory", async () => {
    const createDirectoryTool = await getTool(baseDir, "create_directory");
    const deleteDirectoryTool = await getTool(baseDir, "delete_directory");

    await createDirectoryTool.implementation({ directory_name: "empty-dir" });

    const raw = await deleteDirectoryTool.implementation({ directory_path: "empty-dir" });
    const result = parseResponse<{ directory_name: string; relative_path: string; deleted: boolean; recursive: boolean }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operation).toBe("delete_directory");
      expect(result.data).toEqual({
        directory_name: "empty-dir",
        relative_path: "empty-dir",
        deleted: true,
        recursive: false,
      });
    }
    expect(existsSync(join(baseDir, "empty-dir"))).toBe(false);
  });

  it("returns an error when delete_directory targets a non-empty directory without recursive", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const deleteDirectoryTool = await getTool(baseDir, "delete_directory");

    await writeTool.implementation({ file_name: "non-empty/child.txt", content: "x" });

    const raw = await deleteDirectoryTool.implementation({ directory_path: "non-empty" });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "delete_directory",
      error: {
        code: "DIRECTORY_NOT_EMPTY",
        message: "Directory is not empty; set recursive to true to delete it",
      },
    });
    expect(existsSync(join(baseDir, "non-empty"))).toBe(true);
  });

  it("deletes a non-empty directory when recursive is true", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const deleteDirectoryTool = await getTool(baseDir, "delete_directory");

    await writeTool.implementation({ file_name: "to-delete/nested/file.txt", content: "x" });

    const raw = await deleteDirectoryTool.implementation({
      directory_path: "to-delete",
      recursive: true,
    });
    const result = parseResponse<{ recursive: boolean }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.recursive).toBe(true);
    }
    expect(existsSync(join(baseDir, "to-delete"))).toBe(false);
  });

  it("returns an error when delete_directory path does not exist", async () => {
    const deleteDirectoryTool = await getTool(baseDir, "delete_directory");

    const raw = await deleteDirectoryTool.implementation({ directory_path: "missing-dir" });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "delete_directory",
      error: {
        code: "DIRECTORY_NOT_FOUND",
        message: "Directory does not exist",
      },
    });
  });

  it("blocks delete_directory when path escapes the selected folder", async () => {
    const deleteDirectoryTool = await getTool(baseDir, "delete_directory");

    const raw = await deleteDirectoryTool.implementation({ directory_path: "../outside-dir" });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "delete_directory",
      error: {
        code: "DIRECTORY_PATH_OUTSIDE_BASE",
        message: "Directory path is outside the configured directory.",
      },
    });
  });

  it("returns an error when delete_directory path points to a file", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const deleteDirectoryTool = await getTool(baseDir, "delete_directory");

    await writeTool.implementation({ file_name: "not-a-dir.txt", content: "x" });

    const raw = await deleteDirectoryTool.implementation({ directory_path: "not-a-dir.txt" });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "delete_directory",
      error: {
        code: "DIRECTORY_NOT_DIRECTORY",
        message: "Path is not a directory",
      },
    });
  });

  it("finds a file by exact name recursively and returns a relative path", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const findFileTool = await getTool(baseDir, "find_file");

    await writeTool.implementation({ file_name: "docs/archive/report.md", content: "v1" });

    const raw = await findFileTool.implementation({ file_name: "report.md" });
    const result = parseResponse<{
      match_type: string;
      count: number;
      matches: Array<{ file_name: string; relative_path: string; score: number }>;
    }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.match_type).toBe("exact");
      expect(result.data.count).toBe(1);
      expect(result.data.matches).toEqual([
        {
          file_name: "report.md",
          relative_path: "docs/archive/report.md",
          score: 1,
        },
      ]);
    }
  });

  it("returns full relative paths when multiple files share the same name", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const findFileTool = await getTool(baseDir, "find_file");

    await writeTool.implementation({ file_name: "a/report.md", content: "a" });
    await writeTool.implementation({ file_name: "b/report.md", content: "b" });

    const raw = await findFileTool.implementation({ file_name: "report.md" });
    const result = parseResponse<{
      match_type: string;
      count: number;
      matches: Array<{ relative_path: string; score: number }>;
    }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.match_type).toBe("exact");
      expect(result.data.count).toBe(2);
      expect(result.data.matches[0]?.relative_path).toBe("a/report.md");
      expect(result.data.matches[1]?.relative_path).toBe("b/report.md");
      expect(result.data.matches[0]?.score).toBe(1);
      expect(result.data.matches[1]?.score).toBe(1);
    }
  });

  it("falls back to lax matching when exact filename is not found", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const findFileTool = await getTool(baseDir, "find_file");

    await writeTool.implementation({ file_name: "notes/report-final-2026.md", content: "final" });

    const raw = await findFileTool.implementation({ file_name: "report_2026" });
    const result = parseResponse<{
      match_type: string;
      count: number;
      matches: Array<{ file_name: string; relative_path: string; score: number }>;
    }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.match_type).toBe("lax");
      expect(result.data.count).toBe(1);
      expect(result.data.matches[0]).toMatchObject({
        file_name: "report-final-2026.md",
        relative_path: "notes/report-final-2026.md",
      });
      expect(result.data.matches[0]?.score).toBeGreaterThan(0);
      expect(result.data.matches[0]?.score).toBeLessThan(1);
    }
  });

  it("does not return results when only a directory name matches", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const findFileTool = await getTool(baseDir, "find_file");

    await writeTool.implementation({ file_name: "projects-2026/summary.md", content: "summary" });

    const raw = await findFileTool.implementation({ file_name: "projects-2026" });
    const result = parseResponse<{
      match_type: string;
      count: number;
      matches: Array<{ file_name: string; relative_path: string; score: number }>;
    }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.match_type).toBe("none");
      expect(result.data.count).toBe(0);
      expect(result.data.matches).toEqual([]);
    }
  });

  it("returns a clear message when no file matches", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const findFileTool = await getTool(baseDir, "find_file");

    await writeTool.implementation({ file_name: "present.txt", content: "here" });

    const raw = await findFileTool.implementation({ file_name: "missing-file.txt" });
    const result = parseResponse<{
      match_type: string;
      count: number;
      matches: Array<{ file_name: string; relative_path: string; score: number }>;
    }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.match_type).toBe("none");
      expect(result.data.count).toBe(0);
      expect(result.data.matches).toEqual([]);
    }
  });

  it("supports spaces and special characters in find_file queries", async () => {
    const findFileTool = await getTool(baseDir, "find_file");
    const docsDir = join(baseDir, "docs");
    const filename = "Annual Report (Final) [v2].md";

    await mkdir(docsDir, { recursive: true });
    await writeFileToDisk(join(docsDir, filename), "report", "utf-8");

    const raw = await findFileTool.implementation({ file_name: filename });
    const result = parseResponse<{
      match_type: string;
      count: number;
      matches: Array<{ file_name: string; relative_path: string; score: number }>;
    }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.match_type).toBe("exact");
      expect(result.data.count).toBe(1);
      expect(result.data.matches[0]).toEqual({
        file_name: "Annual Report (Final) [v2].md",
        relative_path: "docs/Annual Report (Final) [v2].md",
        score: 1,
      });
    }
  });

  it("orders lax matches by descending score and then by relative path", async () => {
    const writeTool = await getTool(baseDir, "write_file");
    const findFileTool = await getTool(baseDir, "find_file");

    await writeTool.implementation({ file_name: "notes/report-2026.md", content: "1" });
    await writeTool.implementation({ file_name: "notes/my-report-2026.md", content: "2" });

    const raw = await findFileTool.implementation({ file_name: "report 2026" });
    const result = parseResponse<{
      match_type: string;
      matches: Array<{ relative_path: string; score: number }>;
    }>(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.match_type).toBe("lax");
      expect(result.data.matches.length).toBe(2);
      expect(result.data.matches[0]?.relative_path).toBe("notes/report-2026.md");
      expect(result.data.matches[1]?.relative_path).toBe("notes/my-report-2026.md");
      expect(result.data.matches[0]?.score).toBeGreaterThan(result.data.matches[1]?.score ?? 0);
    }
  });

  it("tells a user to set a folder before reading files", async () => {
    const readTool = await getTool(undefined, "read_file");

    const raw = await readTool.implementation({ file_name: "missing.txt" });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "read_file",
      error: {
        code: "DIR_NOT_SET",
        message: "Directory not set. Use set_directory first.",
      },
    });
  });

  it("tells a user when the requested file does not exist", async () => {
    const readTool = await getTool(baseDir, "read_file");

    const raw = await readTool.implementation({ file_name: "does-not-exist.txt" });
    const result = parseResponse(raw);

    expect(result).toEqual({
      ok: false,
      operation: "read_file",
      error: {
        code: "FILE_NOT_FOUND",
        message: "File does not exist",
      },
    });
  });

  it("saves exactly the content a user provides", async () => {
    const writeTool = await getTool(baseDir, "write_file");

    const firstRaw = await writeTool.implementation({
      file_name: "raw.txt",
      content: "disk check",
    });
    const secondRaw = await writeTool.implementation({
      file_name: "raw.txt",
      content: "disk check 2",
    });

    const firstResult = parseResponse<{ created: boolean; updated: boolean }>(firstRaw);
    const secondResult = parseResponse<{ created: boolean; updated: boolean }>(secondRaw);

    expect(firstResult.ok).toBe(true);
    if (firstResult.ok) {
      expect(firstResult.data.created).toBe(true);
      expect(firstResult.data.updated).toBe(false);
    }

    expect(secondResult.ok).toBe(true);
    if (secondResult.ok) {
      expect(secondResult.data.created).toBe(false);
      expect(secondResult.data.updated).toBe(true);
    }

    const diskContent = await readFile(join(baseDir, "raw.txt"), "utf-8");
    expect(diskContent).toBe("disk check 2");
  });
});


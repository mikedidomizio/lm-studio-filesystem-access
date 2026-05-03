# LM Studio Tool Plugin - Filesystem Access

Allows filesystem access for the following actions:

- list_files
- create_directory
- write_file
- read_file
- find_file
- move_file
- delete_file
- move_directory
- delete_directory
- copy_file
- copy_directory
- path_exists

## JSON Response Contract

All tools now return a JSON string with one of the following shapes:

```json
{
  "ok": true,
  "operation": "write_file",
  "data": {}
}
```

```json
{
  "ok": false,
  "operation": "read_file",
  "error": {
	"code": "FILE_NOT_FOUND",
	"message": "File does not exist"
  }
}
```

### Error Object

- `code`: stable machine-readable error code
- `message`: human-readable explanation

Current error codes include:

- `DIR_NOT_SET`
- `DIR_NOT_AVAILABLE`
- `FILE_PATH_OUTSIDE_BASE`
- `DIRECTORY_PATH_OUTSIDE_BASE`
- `FILE_NOT_FOUND`
- `FILE_NOT_FILE`
- `DIRECTORY_NOT_FOUND`
- `DIRECTORY_NOT_DIRECTORY`
- `DIRECTORY_NOT_EMPTY`
- `DELETE_FAILED`
- `PATH_OUTSIDE_BASE`

`path_exists` can also return:

- `PATH_OUTSIDE_BASE`

`move_file` can also return:

- `SOURCE_PATH_OUTSIDE_BASE`
- `DESTINATION_PATH_OUTSIDE_BASE`
- `SOURCE_EQUALS_DESTINATION`
- `SOURCE_FILE_NOT_FOUND`
- `SOURCE_NOT_FILE`
- `DESTINATION_IS_DIRECTORY`
- `DESTINATION_EXISTS`
- `CROSS_DEVICE_MOVE_UNSUPPORTED`
- `MOVE_FAILED`

`copy_file` can also return:

- `SOURCE_PATH_OUTSIDE_BASE`
- `DESTINATION_PATH_OUTSIDE_BASE`
- `SOURCE_EQUALS_DESTINATION`
- `SOURCE_FILE_NOT_FOUND`
- `SOURCE_NOT_FILE`
- `DESTINATION_IS_DIRECTORY`
- `DESTINATION_EXISTS`
- `COPY_FAILED`

`copy_directory` can also return:

- `SOURCE_PATH_OUTSIDE_BASE`
- `DESTINATION_PATH_OUTSIDE_BASE`
- `SOURCE_EQUALS_DESTINATION`
- `DESTINATION_INSIDE_SOURCE`
- `SOURCE_DIRECTORY_NOT_FOUND`
- `SOURCE_NOT_DIRECTORY`
- `DESTINATION_NOT_DIRECTORY`
- `DESTINATION_EXISTS`
- `COPY_FAILED`

`move_directory` can also return:

- `SOURCE_PATH_OUTSIDE_BASE`
- `DESTINATION_PATH_OUTSIDE_BASE`
- `SOURCE_EQUALS_DESTINATION`
- `DESTINATION_INSIDE_SOURCE`
- `SOURCE_DIRECTORY_NOT_FOUND`
- `SOURCE_NOT_DIRECTORY`
- `DESTINATION_NOT_DIRECTORY`
- `DESTINATION_EXISTS`
- `CROSS_DEVICE_MOVE_UNSUPPORTED`
- `MOVE_FAILED`

## File Move Behavior

`move_file` moves a file from `source_path` to `destination_path` within the configured base directory.

1. Both paths must resolve inside the configured base directory.
2. `source_path` must exist and be a file.
3. If destination exists and `overwrite` is not `true`, the tool returns `DESTINATION_EXISTS`.
4. If needed, parent directories for `destination_path` are created automatically.

## File Copy Behavior

`copy_file` copies a file from `source_path` to `destination_path` within the configured base directory.

1. Both paths must resolve inside the configured base directory.
2. `source_path` must exist and be a file.
3. Source and destination cannot be the same path.
4. If destination exists and `overwrite` is not `true`, the tool returns `DESTINATION_EXISTS`.
5. If needed, parent directories for `destination_path` are created automatically.

## Directory Copy Behavior

`copy_directory` copies a directory from `source_path` to `destination_path` within the configured base directory.

1. Both paths must resolve inside the configured base directory.
2. `source_path` must exist and be a directory.
3. Source and destination cannot be the same path.
4. Destination cannot be nested inside source.
5. If destination exists and `overwrite` is not `true`, the tool returns `DESTINATION_EXISTS`.
6. If needed, parent directories for `destination_path` are created automatically.

## Directory Move Behavior

`move_directory` moves a directory from `source_path` to `destination_path` within the configured base directory.

1. Both paths must resolve inside the configured base directory.
2. `source_path` must exist and be a directory.
3. Destination cannot be the same as source, and cannot be nested inside source.
4. If destination exists and `overwrite` is not `true`, the tool returns `DESTINATION_EXISTS`.
5. If needed, parent directories for `destination_path` are created automatically.

## File Delete Behavior

`delete_file` deletes a single file at `file_name` within the configured base directory.

1. The resolved path must stay inside the configured base directory.
2. The target must exist and be a file (not a directory).
3. On success, the tool returns `deleted: true` with `file_name` and `relative_path`.

## Directory Delete Behavior

`delete_directory` deletes a directory at `directory_path` within the configured base directory.

1. The resolved path must stay inside the configured base directory.
2. The target must exist and be a directory (not a file).
3. By default `recursive` is `false`; non-empty directories return `DIRECTORY_NOT_EMPTY`.
4. Set `recursive: true` to delete non-empty directories.

## File Search Behavior

`find_file` searches recursively inside the configured base directory:

1. It tries an exact filename match first (case-insensitive on the basename).
2. If no exact matches exist, it applies a lax fallback pattern match on the filename only (not directory names).
3. The `file_name` query supports spaces and common filename characters.
4. It returns ranked `matches` with fields: `file_name`, `relative_path`, `score`.
5. Exact matches use `score: 1` and `match_type: "exact"`.
6. Lax matches use `0 < score < 1` and `match_type: "lax"`.
7. If no matches are found, `ok` remains `true` with `match_type: "none"` and `matches: []`.

Example `find_file` success payload:

```json
{
  "ok": true,
  "operation": "find_file",
  "data": {
	"query": "report_2026",
	"match_type": "lax",
	"count": 1,
	"matches": [
	  {
		"file_name": "report-final-2026.md",
		"relative_path": "notes/report-final-2026.md",
		"score": 0.83
	  }
	]
  }
}
```

## Path Input Rules

`write_file`, `read_file`, `find_file`, and `create_directory` accept names with spaces and common path characters.
Path safety is enforced by keeping all resolved paths inside the configured base directory.

## Path Exists Behavior

`path_exists` checks whether a path exists inside the configured base directory.

1. If the path exists, it returns `exists: true` and `path_type` as `file` or `directory`.
2. If the path does not exist, it returns `ok: true` with `exists: false` and `path_type: "missing"`.
3. If the path resolves outside the configured base directory, it returns `PATH_OUTSIDE_BASE`.

## Testing

This project uses `vitest` for unit tests.

Install dependencies and run tests:

```bash
npm install
npm test
```

Watch mode:

```bash
npm run test:watch
```

Coverage report:

```bash
npm run test:coverage
```

Coverage output is generated in `coverage/` with HTML (`coverage/index.html`) and lcov formats.
The coverage run includes a threshold gate and fails if global coverage drops below: statements 80%, lines 80%, functions 70%, branches 60%.



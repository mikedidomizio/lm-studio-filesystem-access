# LM Studio Tool Plugin - Filesystem Access

Allows filesystem access for the following actions:

- list_files
- create_directory
- write_file
- read_file
- find_file

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



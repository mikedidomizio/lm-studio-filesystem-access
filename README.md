# LM Studio Tool Plugin - Filesystem Access

Allows filesystem access for the following actions:

- list_files_in_directory
- create_directory
- write_file
- read_file
- find_file

## File Search Behavior

`find_file` searches recursively inside the configured base directory:

1. It tries an exact filename match first (case-insensitive on the basename).
2. If no exact matches exist, it applies a lax fallback pattern match on the filename only (not directory names).
3. The `file_name` query supports spaces and common filename characters.
4. It returns relative paths.
5. If multiple files share the same filename, each result includes its full relative path.
6. Each match explicitly includes both `file_name` and `relative_path`.

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



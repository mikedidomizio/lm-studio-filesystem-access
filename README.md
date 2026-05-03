# Lmstudio Tool Plugin - Filesystem Access

Allows filesystem access for the following actions to a user specified directory:

- list_files_in_directory
- create_directory
- write_file
- read_file

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



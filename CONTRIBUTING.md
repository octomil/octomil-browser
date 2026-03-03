# Contributing to Octomil Browser SDK

Thank you for your interest in contributing to the Octomil Browser SDK! This guide will help you get started.

## Table of Contents

- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Code Style](#code-style)
- [Testing Requirements](#testing-requirements)
- [Commit Message Conventions](#commit-message-conventions)
- [Code of Conduct](#code-of-conduct)

## Reporting Bugs

If you find a bug, please open an issue on [GitHub Issues](https://github.com/octomil/octomil-browser/issues) with the following information:

- A clear and descriptive title
- Steps to reproduce the issue
- Expected behavior vs. actual behavior
- Browser and OS information (including WebGPU support status)
- Relevant console logs or error messages
- A minimal code snippet that reproduces the problem, if possible

## Requesting Features

Feature requests are welcome! Please open an issue on [GitHub Issues](https://github.com/octomil/octomil-browser/issues) and include:

- A clear description of the feature and the problem it solves
- Example usage or API design, if applicable
- Any relevant context or alternatives you have considered

## Development Setup

### Prerequisites

- **Node.js** 18 or later
- **pnpm** (install via `corepack enable` or `npm install -g pnpm`)

### Setup

1. Fork the repository and clone your fork
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Verify the setup by running the test suite:
   ```bash
   pnpm test
   ```

### Common Commands

| Command | Description |
|---------|-------------|
| `pnpm build` | Build the package |
| `pnpm test` | Run tests |
| `pnpm lint` | Lint the codebase |
| `pnpm format` | Format code with Prettier |

## Pull Request Process

1. **Fork** the repository and create a new branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. **Make your changes** in focused, incremental commits.
3. **Ensure all tests pass** and add new tests for any new functionality.
4. **Push** your branch to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
5. **Open a Pull Request** against the `main` branch of this repository.
6. **Respond to review feedback** promptly. A maintainer will review your PR and may request changes.
7. Once approved, a maintainer will merge your PR.

### PR Guidelines

- Keep PRs focused on a single change or feature.
- Include a clear description of what the PR does and why.
- Reference any related issues (e.g., "Closes #42").
- Ensure CI checks pass before requesting review.

## Code Style

This project enforces consistent code style using the following tools:

- **[ESLint](https://eslint.org/)** -- Linting for TypeScript code. Run locally with:
  ```bash
  pnpm lint
  ```
- **[Prettier](https://prettier.io/)** -- Code formatting. Run locally with:
  ```bash
  pnpm format
  ```
- **[SonarCloud](https://sonarcloud.io/)** -- Automated code quality and security analysis runs on every PR.

Please ensure your code passes all lint and format checks before submitting a PR.

## Testing Requirements

- **All tests must pass.** Run the full test suite with:
  ```bash
  pnpm test
  ```
- **New code must include tests.** All new features and bug fixes should be accompanied by appropriate test coverage.
- **Coverage is required.** Aim to maintain or improve the current code coverage level. Avoid submitting PRs that reduce coverage.

## Commit Message Conventions

Use clear, descriptive commit messages following this format:

```
<type>: <short summary>

<optional body with more detail>
```

**Types:**

- `feat` -- A new feature
- `fix` -- A bug fix
- `docs` -- Documentation changes
- `test` -- Adding or updating tests
- `refactor` -- Code refactoring with no functional change
- `chore` -- Maintenance tasks (CI, dependencies, etc.)

**Examples:**

```
feat: add WebGPU backend auto-detection
fix: resolve memory leak in model dispose
docs: update installation instructions in README
```

## Code of Conduct

We are committed to providing a welcoming and inclusive experience for everyone. All participants are expected to:

- **Be respectful** -- Treat others with courtesy and respect. Disagreements are fine; personal attacks are not.
- **Be constructive** -- Provide helpful feedback and focus on improving the project.
- **Be inclusive** -- Welcome newcomers and help them get started.
- **Be professional** -- Harassment, discrimination, and abusive behavior will not be tolerated.

If you experience or witness unacceptable behavior, please report it by opening an issue or contacting the maintainers directly.

---

Thank you for contributing to Octomil!

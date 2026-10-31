---
title: "Reproducible development environment"
description: "From terminals, PATH, dependencies, and ports to SSH, turn 'it works on my machine' into a verifiable environment contract."
---

A development environment is not just a collection of software coincidentally gathered on a single machine. It is a set of conditions that can be checked, recorded, and recreated: operating system, runtime, dependencies, environment variables, ports, permissions, external services, and the working directory where commands are executed.

The difficulty with environment issues is usually not that the configuration is too advanced, but that there is an implicit assumption that has not been documented. Turning these conditions into observable facts transforms the problem from "mystical" into one that can be troubleshooted.

## 1. The Environment is a Contract

| Item | What Needs to be Clear | Behavior When Out of Control |
| --- | --- | --- |
| Operating System | Windows, macOS, Linux, CPU architecture | Binary incompatibility, different path and permission behaviors |
| Runtime | Node, Python, Java, Go versions | Works on local machine, but CI or server reports syntax/API errors |
| Dependencies | lockfile, virtual environment, image version | The version installed today differs from yesterday |
| Configuration | Environment variables, config files, defaults | Missing parameters at startup, or silently connecting to the wrong environment |
| Network | Listening address, ports, proxies, DNS, firewall | Process is running but requests cannot reach it |
| Credentials | Keys, certificates, access tokens | Works locally, rejected online; or secrets are leaked |
| External Services | Database, object storage, email, third-party API | Passes tests, but times out or returns incorrect schema during integration |

The true minimum reproducible standard is: take a clean machine, install dependencies, set configurations, start services according to the repository records, and successfully complete one verifiable request. It's not "I have it on my computer," nor "it worked last time."

## 2. Terminal, Shell, and Processes

We often mix up terminal and shell in daily talk, but they have different responsibilities.

- **Terminal** is the input/output window, responsible for displaying characters, handling the keyboard, and colors.
- **Shell** is the program that interprets commands, such as Bash, Zsh, PowerShell, fish.
- **Commands** usually start a new process; the shell is responsible for parsing arguments, pipelines, redirection, and environment variables.

```text
Keyboard input → terminal → Shell parse → start subprocess
                        │            │
                        │       stdout / stderr
                        ▼            │
                     Pipes/Redirect ◄───┘
```

Shell's own built-in commands (such as `cd`) do not necessarily start a new process. External commands usually have exit codes: `0` generally indicates success, and non-zero indicates failure, but the specific meaning is defined by the program.

### 2.1 Standard Input, Output, and Error

Each process typically has three standard streams:

| Stream | File Descriptor | Purpose |
| --- | --- | --- |
| stdin | 0 | Input |
| stdout | 1 | Normal Output |
| stderr | 2 | Error and Diagnostic Information |

```bash
rg "timeout" src > matches.txt
python job.py > job.log 2>&1
some-command < input.txt
```

`>` Overwrite the file, `>>` Append, `2>&1` Redirect stderr to the current location of stdout. Pipe `|` passes the stdout of the previous command to the stdin of the next command. By default, a pipe only transfers stdout; the error stream is still displayed directly unless explicitly redirected.

### 2.2 Command Combination and Failure Handling

```bash
set -euo pipefail
input="${1:?missing input file}"
test -f "$input"
python -m json.tool "$input" > /dev/null
```

- Exit when a command fails. 
- Report an error when using an undefined variable. 
- Make the failure of any command in a pipeline affect the overall exit code. 
- Enclose variables in double quotes to prevent spaces, wildcards, and empty values from being reinterpreted. 
- Do not concatenate untrusted input into `eval`, `sh -c`, or database statements.

PowerShell's rules for variables, quoting, and error handling differ from Bash. `$env:PATH` reads environment variables, `$LASTEXITCODE` saves the exit code of an external command, and `&&`'s availability and error behavior also depend on the version. Do not run scripts from Bash tutorials directly on Windows.

## 3. PATH: Why commands cannot be found

After a shell receives a command name, it searches for executable files in the order of directories listed in `PATH`. When multiple versions of a tool with the same name are installed, the directory listed first usually wins.

```bash
# macOS / Linux
which node
command -v node
node --version
printf '%s\n' "$PATH"
```

```powershell
# Windows PowerShell
Get-Command node
node --version
$env:PATH
```

Troubleshooting Order:

1. Check whether the command is actually installed.
2. Check whether the installation directory is in `PATH`.
3. Check whether the current terminal has been reopened after installation; old processes may retain the old environment.
4. Check whether there are multiple versions, and which one is actually being used.
5. Check whether the project requires using a version manager or container instead of the system global version.

`PATH` The order, shell configuration files, and IDE startup methods may all differ. Editors in graphical interfaces do not necessarily inherit the variables you just set in the terminal. In this case, you should check within the IDE's terminal or project configuration.

## 4. Environment Variables and Configuration

Environment variables are a set of key-value pairs inherited when a process starts. They are suitable for placing runtime environment information, log levels, external service addresses, and non-sensitive switches. Sensitive values can be injected by a secret management service and should not be written into the source code or committed to the repository.

```bash
export DATABASE_URL="postgres://localhost/app"
export LOG_LEVEL="debug"
```

```powershell
$env:DATABASE_URL = "postgres://localhost/app"
$env:LOG_LEVEL = "debug"
```

In the current shell, `VAR=value` is not necessarily passed to child processes; Bash requires `export`. Windows PowerShell uses `$env:VAR`. It is common to save local development values in `.env` files, but they must also be excluded in `.gitignore` and a `.env.example` without real keys should be provided.

Configuration reading should follow a clear priority, for example: command line arguments > environment variables > project configuration files > default values. When priorities are unclear, it is easy for production and local environments to quietly use different values.

## 5. Dependencies and Package Managers

Package managers solve more than just 'downloading libraries.' They also handle version resolution, dependency trees, lock files, scripts, caching, and executable installations.

| Ecosystem | Common Tools | Lock File / Isolation Method |
| --- | --- | --- |
| JavaScript / Node | npm, pnpm, yarn | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` |
| Python | pip, uv, poetry, conda | `requirements.txt`, `pyproject.toml`, virtual environments |
| Java | Maven, Gradle | dependency locks and repository cache |
| Go | go mod | `go.mod`, `go.sum` |
| Rust | Cargo | `Cargo.toml`, `Cargo.lock` |

### 5.1 Version Ranges Are Not the Same as Fixed Versions

Semantic versioning often uses `major.minor.patch` to indicate compatibility, such as `2.4.1`. But semantic versioning is a convention, not a fact that the compiler can verify. `^2.4.1` may allow installation of new minor versions, `~2.4.1` may only allow patch updates. Teams must decide on upgrade strategies and re-validate in CI.

```bash
npm ci
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

`npm ci` Install exactly according to the lockfile, suitable for automation and production builds; `npm install` may update dependency resolution results. Python projects should create an independent virtual environment for each project and not package everything into the system Python.

### 5.2 Dependency Security and Maintainability

- Only install packages from trusted sources, pay attention to package name spelling and publisher.
- Regularly check security announcements and upgrade logs; do not blindly execute installation scripts.
- Lock dependencies for production builds and keep traceable lockfiles.
- Do not commit `node_modules`, virtual environments, model weights, or build caches to the repository.
- Fewer dependencies usually mean a smaller attack surface and lower maintenance costs, but avoid reinventing the wheel just for "zero dependencies".

## 6. Ports, Localhost, and Network Boundaries

For a process to receive network requests, it must listen on a certain address and port. The address determines "who can connect," and the port determines "which process receives it."

| Listening Address | Meaning |
| --- | --- |
| `127.0.0.1` | Only accepts local loopback connections |
| `::1` | IPv6 loopback address |
| `0.0.0.0` | Accepts connections on all IPv4 network interfaces |
| `::` | Accepts connections on all IPv6 network interfaces, actual behavior depends on the system |

It is common practice and a safer choice for the development server to default to listening on `127.0.0.1`. To allow LAN or public network access, you need to explicitly bind to a broader address and also consider firewalls, reverse proxies, TLS, and authentication.

```bash
ss -ltnp | grep 8000
curl -v http://127.0.0.1:8000/health
```

```powershell
netstat -ano | findstr :8000
Test-NetConnection 127.0.0.1 -Port 8000
```

Common Misconceptions:

- A running process doesn't mean it's listening on the expected network interface.
- Being able to access it locally doesn't mean it's accessible outside the container or via the public network.
- Ports might have changed, but the front-end, proxies, or health checks may still point to the old port.
- After HTTPS proxy termination, the application only sees the proxy's IP; trusted forwarding headers need to be passed correctly.

## 7. IDE and Debugger: Tools Are Not Magic

The truly valuable parts of an IDE are language services, breakpoint debugging, task running, terminal, version control diffs, and navigation capabilities. Configuration should serve the project, not hide critical workflows in personal settings.

When opening an unfamiliar repository, do a few things first:

1. Find the project root directory and documentation files.
2. Confirm runtime version, dependency installation commands, and entry points.
3. Read task scripts; don't run arbitrary scripts without checking.
4. Set up project-level formatting, linting, type checking, and test commands.
5. Use breakpoints or logs to verify a real request path once.

A debugger can pause processes, inspect variables, step through code, and set conditional breakpoints. It's more suitable for understanding control flow than adding print statements everywhere; but in distributed systems, logs, traces, and metrics are still irreplaceable.

## 8. Regular Expressions: Pattern Matching in Finite Text

Regular expressions are used to match string patterns, suitable for format validation, extracting log fields, and simple replacements. They are not full parsers and are not suitable for parsing nested syntax like HTML, JSON, SQL, etc.

```text
^2026-\d{2}-\d{2}$          # Date format
(?i)error:\s (?<code>[A-Z_] ) # Named group to extract error code
```

Basic Components:

- `[]` represents a character set, `\d` represents a digit, `\w` represents a letter/digit/underscore.
- `*`, `+`, `?` control the number of repetitions, `{2,4}` specifies a range.
- `^`, `$` anchor the beginning and end of a line, but multiline mode will change their meaning.
- `()` is grouping, `(?:...)` is non-capturing group, `|` represents alternation.
- `.*?` is non-greedy matching, but it cannot solve nested syntax problems.

Complex regex can cause catastrophic backtracking. When processing untrusted long text, limit the length, use timeouts, and prefer mature parsers. Email addresses, ID numbers, and URLs should not rely solely on a single "universal regex" to validate business logic.

## 9. SSH: Establish Trust Using Keys

SSH allows you to log into remote machines or access Git repositories over an encrypted channel. Password login is prone to brute-force attempts and forwarding; in practice, key pairs are more commonly used.

- Keep your private key on your own device, and restrict permissions so that only you can read it.
- The public key can be placed on the server or code hosting platform.
- Private keys should never be committed, uploaded to chat tools, or written into scripts.

```bash
ssh-keygen -t ed25519 -C "work-laptop"
ssh-copy-id user@example.com
ssh -T git@github.com
```

You can save the host alias, username, and key path in `~/.ssh/config`:

```text
Host deploy
  HostName 203.0.113.10
  User deploy
  IdentityFile ~/.ssh/id_ed25519_deploy
  ServerAliveInterval 30
```

The first connection will record the host fingerprint. When the fingerprint changes suddenly, it should be verified instead of being deleted directly `known_hosts`. Automated tasks should use dedicated keys and only grant permissions to the repositories or hosts they need. The server side should also limit login users, disable unnecessary password logins, and keep audit logs.

## 10. Turn the environment into a verifiable process

A reliable startup process should at least include:

1. Check the runtime and package manager versions.
2. Install dependencies from the lock file.
3. Verify that required configurations exist without printing sensitive values.
4. Start dependent services or confirm that remote dependencies are available.
5. Start the application and wait for the health check to pass.
6. Send a minimal request to check the status code and response structure.
7. On failure, output reproducible error context instead of just showing 'startup failed'.

```text
Version Check → Dependency Installation → Configuration Check → Start Service
    → Health Check → Minimum Request → Logs/Trace
```

Environment documentation does not need to be written as a complete installation guide for all operating systems. It should clearly state: which platforms are supported, which runtime version to use, how to install dependencies, how to start, how to verify, and which values must be provided by the user.

## Checklist

- Test on a clean machine to see if the process can be reproduced according to the documentation.
- Ensure the runtime, package manager, and dependency versions have clear sources.
- Check if the lockfile is committed and whether the dependency directory is ignored.
- Provide examples for environment variables, ensuring real keys never enter the version control.
- Service listening addresses and ports should match the documentation, proxies, and health checks.
- Distinguish between local machines, containers, LAN, and external network boundaries.
- Ensure IDE, Shell, and CI use the same set of commands.
- SSH private keys should only be on local machines with minimal permissions.
- When errors occur, there should be exit codes, logs, and request IDs, not just vague messages.

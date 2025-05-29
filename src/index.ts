#!/usr/bin/env node

/**
 * Express server for Git worktree management
 */

import express from "express";
import * as vite from "vite";
import { WebSocketServer } from "ws";
import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define the actual main branch of your Git repository.
// This is used as the base for creating new worktree-specific branches.
// IMPORTANT: Change this if your main branch is named differently (e.g., "master").
const ACTUAL_MAIN_BRANCH = "main";

/**
 * Get the parent directory name to use for worktree placement
 */
function getWorktreesDir(repoPath: string): string {
  const dirName = path.basename(repoPath);
  const parentDir = path.dirname(repoPath);
  return path.join(parentDir, `${dirName}-worktrees`);
}

function parseArgs(): { port: number; repoPath: string } {
  let port = 5173; // Default port
  let repoPath = process.cwd(); // Default repo path

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) {
      const parsedPort = parseInt(args[i + 1], 10);
      if (!isNaN(parsedPort)) {
        port = parsedPort;
      } else {
        console.error(`Invalid port: ${args[i + 1]}`);
        process.exit(1);
      }
      i++; // Skip the next argument as we've already processed it
    } else if (args[i] === "--repo-path" && i + 1 < args.length) {
      repoPath = path.resolve(args[i + 1]);
      i++; // Skip the next argument
    }
  }

  return { port, repoPath };
}

/**
 * Execute a shell command and return a promise
 */
function execCommand(
  command: string,
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stderr });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function getCurrentBranch(repoPath: string): Promise<string | null> {
  console.log(`[getCurrentBranch] Called with repoPath: ${repoPath}`);
  try {
    // Check if it's a git repository and get current branch
    // HEAD itself means it's a git repo but in detached HEAD state or no branch yet
    const { stdout: isGitRepoStdout } = await execCommand(
      "git rev-parse --is-inside-work-tree",
      repoPath
    );
    const isGitRepo = isGitRepoStdout.trim();
    console.log(`[getCurrentBranch] isGitRepo command output: '${isGitRepo}'`);
    if (isGitRepo !== "true") {
      console.log(
        `[getCurrentBranch] Not a git repo or not inside work tree. Returning null.`
      );
      return null;
    }

    const { stdout: branchStdout } = await execCommand(
      "git rev-parse --abbrev-ref HEAD",
      repoPath
    );
    const branch = branchStdout.trim();
    console.log(`[getCurrentBranch] branch command output: '${branch}'`);

    const result = branch === "HEAD" ? null : branch;
    console.log(`[getCurrentBranch] Returning: ${result}`);
    return result; // 'HEAD' means detached or no branch
  } catch (error: any) {
    console.error(
      `[getCurrentBranch] Error: ${error.message}. Stack: ${error.stack}`
    );
    console.log(`[getCurrentBranch] Error caught. Returning null.`);
    return null;
  }
}

/**
 * Validate worktree name to prevent command injection
 */
function isValidWorktreeName(name: string): boolean {
  // Only allow alphanumeric characters, dashes, and underscores
  return /^[a-zA-Z0-9-_]+$/.test(name);
}

/**
 * Parses `git worktree list --porcelain` output to find the path of the worktree using the given branch name.
 * Returns the path if found, otherwise null.
 */
async function getWorktreePathForBranch(
  branchName: string,
  repoPath: string
): Promise<string | null> {
  // repoPath is now passed as an argument
  console.log(
    `[getWorktreePathForBranch] Called with branchName: '${branchName}', repoPath: '${repoPath}'`
  );
  try {
    const { stdout } = await execCommand(
      "git worktree list --porcelain",
      repoPath
    );
    const worktreeEntries = stdout.split("\n\n");
    for (const entry of worktreeEntries) {
      if (!entry.trim()) continue;
      const lines = entry.split("\n");
      let currentPath = "";
      let currentBranch = "";
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          currentPath = line.substring("worktree ".length);
        } else if (line.startsWith("branch refs/heads/")) {
          currentBranch = line.substring("branch refs/heads/".length);
        }
      }
      if (currentPath && currentBranch === branchName) {
        return path.resolve(currentPath); // Found in a linked worktree
      }
    }
    return null;
  } catch (error) {
    console.error(
      `Error parsing worktree list for branch '${branchName}':`,
      error
    );
    // Do not throw here, proceed to check current CWD branch
  }
  console.log(
    `[getWorktreePathForBranch] Porcelain check did not find or errored for branch '${branchName}'.`
  );

  // If not found in linked worktrees, check if the CWD itself is on this branch
  const currentBranchOfCwd = await getCurrentBranch(repoPath);
  console.log(
    `[getWorktreePathForBranch] currentBranchOfCwd: '${currentBranchOfCwd}' (comparing with '${branchName}')`
  );

  if (currentBranchOfCwd === branchName) {
    const result = path.resolve(repoPath);
    console.log(
      `[getWorktreePathForBranch] CWD is on branch '${branchName}'. Returning path: '${result}'`
    );
    return result;
  }

  console.log(
    `[getWorktreePathForBranch] Branch '${branchName}' not found in CWD or linked worktrees. Returning null.`
  );
  return null; // Branch not found in any worktree or CWD
}

/**
 * Create a new Git worktree
 */
async function createWorktree(
  name: string,
  repoPath: string
): Promise<{
  success: boolean;
  message: string;
  details?: any; // Allow more flexible error details
}> {
  const targetWorktreePath = path.join(getWorktreesDir(repoPath), name);
  const branchForWorktree = `${name}-branch`; // Use a derived branch name
  console.log(
    `[createWorktree] For name '${name}', using branchForWorktree: '${branchForWorktree}', targetWorktreePath: '${targetWorktreePath}'`
  );

  try {
    // Check if the desired branchForWorktree is already used by any worktree (including CWD)
    const existingPathForBranch = await getWorktreePathForBranch(
      branchForWorktree,
      repoPath
    );
    console.log(
      `[createWorktree] existingPathForBranch for '${branchForWorktree}': '${existingPathForBranch}'`
    );
    if (existingPathForBranch) {
      if (
        path.resolve(existingPathForBranch) === path.resolve(targetWorktreePath)
      ) {
        return {
          success: true,
          message: `Worktree '${name}' for branch '${branchForWorktree}' already exists at '${targetWorktreePath}'.`,
        };
      } else {
        return {
          success: false,
          message: `Failed to create worktree: Branch '${branchForWorktree}' is already checked out by another worktree at '${existingPathForBranch}'. Please use a different worktree name or resolve the conflict.`,
        };
      }
    }

    // If branchForWorktree is not in use, check the targetWorktreePath itself.
    // Is targetWorktreePath an existing worktree for a *different* branch?
    const { stdout: wtListStdOut } = await execCommand(
      "git worktree list --porcelain",
      repoPath
    );
    const worktreeEntries = wtListStdOut.split("\n\n");
    for (const entry of worktreeEntries) {
      if (!entry.trim()) continue;
      const lines = entry.split("\n");
      let currentEntryPath = "";
      let currentEntryBranch = "";
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          currentEntryPath = line.substring("worktree ".length);
        } else if (line.startsWith("branch refs/heads/")) {
          currentEntryBranch = line.substring("branch refs/heads/".length);
        }
      }
      if (path.resolve(currentEntryPath) === path.resolve(targetWorktreePath)) {
        // Path is an existing worktree. Is it for the branch we intend to use?
        if (currentEntryBranch !== branchForWorktree) {
          // it must be for a different branch.
          return {
            success: false,
            message: `Failed to create worktree: Directory '${targetWorktreePath}' is already a worktree for branch '${currentEntryBranch}'. Cannot use it for branch '${branchForWorktree}'.`,
          };
        }
      }
    }

    // If targetWorktreePath exists as a plain directory and is not empty, 'git worktree add' will fail.
    if (fs.existsSync(targetWorktreePath)) {
      const filesInDir = fs.readdirSync(targetWorktreePath);
      if (filesInDir.length > 0) {
        return {
          success: false,
          message: `Failed to create worktree: Directory '${targetWorktreePath}' already exists and is not empty. Please remove it or use a different name.`,
        };
      }
      // If it's an empty directory, 'git worktree add' is fine.
    }

    // All pre-checks passed. Proceed with creation.
    // Ensure parent worktrees directory exists
    const worktreesDir = getWorktreesDir(repoPath);
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    // Verify that ACTUAL_MAIN_BRANCH is a valid commit (needed if we create a new branch from it)
    try {
      await execCommand(
        `git rev-parse --verify ${ACTUAL_MAIN_BRANCH}^{commit}`,
        repoPath
      );
    } catch (checkError: any) {
      return {
        success: false,
        message: `Failed to create worktree: The base branch '${ACTUAL_MAIN_BRANCH}' for new branches is not a valid commit or does not exist. Details: ${
          checkError.stderr || checkError.message
        }`,
      };
    }

    // Determine if branchForWorktree already exists
    let branchDidExist = false;
    try {
      await execCommand(
        `git show-ref --verify --quiet refs/heads/${branchForWorktree}`,
        repoPath
      );
      branchDidExist = true;
      console.log(
        `[createWorktree] Branch '${branchForWorktree}' already exists (but is not checked out by CWD or other linked worktrees).`
      );
    } catch (error) {
      console.log(
        `[createWorktree] Branch '${branchForWorktree}' does not exist yet.`
      );
      branchDidExist = false;
    }

    let addCmdOutput;
    if (!branchDidExist) {
      // Branch does not exist. Create it and the worktree, based on ACTUAL_MAIN_BRANCH.
      console.log(
        `[createWorktree] Attempting: git worktree add -b ${branchForWorktree} ${targetWorktreePath} ${ACTUAL_MAIN_BRANCH}`
      );
      addCmdOutput = await execCommand(
        `git worktree add -b ${branchForWorktree} ${targetWorktreePath} ${ACTUAL_MAIN_BRANCH}`,
        repoPath
      );
    } else {
      // Branch exists but is not checked out by any worktree (verified by earlier checks).
      // Add worktree for this existing, unattached branch.
      console.log(
        `[createWorktree] Attempting: git worktree add ${targetWorktreePath} ${branchForWorktree}`
      );
      addCmdOutput = await execCommand(
        `git worktree add ${targetWorktreePath} ${branchForWorktree}`,
        repoPath
      );
    }

    // Run pnpm install in the new worktree directory
    console.log(
      `[createWorktree] Running pnpm install in ${targetWorktreePath}`
    );
    try {
      const { stdout: pnpmOutput, stderr: pnpmError } = await execCommand(
        "pnpm install",
        targetWorktreePath
      );
      console.log(
        `[createWorktree] Successfully ran pnpm install in ${targetWorktreePath}`
      );
      if (pnpmError) {
        console.warn(`[createWorktree] pnpm install warnings: ${pnpmError}`);
      }
    } catch (installError: any) {
      console.error(
        `[createWorktree] Error running pnpm install: ${
          installError.message || installError.stderr || "Unknown error"
        }. Worktree created, but dependencies not installed.`
      );
      // Even if pnpm install fails, we continue with the worktree creation process
      // as the user can manually install dependencies later
    }

    return {
      success: true,
      message: `Successfully created worktree '${name}' on branch '${branchForWorktree}' at '${targetWorktreePath}'`,
      details: addCmdOutput,
    };
  } catch (error: any) {
    console.error("Error creating worktree:", error);
    return {
      success: false,
      message: `Failed to create worktree: ${
        error.stderr || error.message || "Unknown error"
      }`,
      // Include details from the error if available, otherwise the generic message
      details: {
        stderr: error.stderr,
        message: error.message,
        errorObject: error.toString(),
      },
    };
  }
}

function main() {
  const viteServers: Record<string, any> = {};
  const { port, repoPath } = parseArgs();
  const app = express();

  // Create the HTTP server instance *before* it's used by Vite HMR
  const appServer = app.listen(port, () => {
    console.log(
      `Server running at http://localhost:${port} in repo ${repoPath}`
    );
  });
  // cookieParser removed

  // Middleware to handle requests, determine worktree from path, and proxy to Vite
  app.use("/:worktree", async (req, res, next) => {
    // Worktree name is now from req.params.worktree due to the route "/:worktree/*"
    const worktreeFromParam = req.params.worktree;
    const server = viteServers[worktreeFromParam];

    if (server) {
      return server.middlewares(req, res, next);
    }

    let worktree: string; // Will be set to worktreeFromParam
    let viteBasePath: string; // Will be /<worktree>/
    let actualReqPathForVite: string; // Will be the path *after* /<worktree>/

    if (worktreeFromParam && isValidWorktreeName(worktreeFromParam)) {
      worktree = worktreeFromParam;
      viteBasePath = `/${worktree}/`;
      // req.path in a route handler for "/:worktree/*" is the part matched by "*".
      // Example: URL "/featureA/path/to/asset"
      //   req.params.worktree = "featureA"
      //   req.path = "/path/to/asset" (Express typically includes the leading slash for the wildcard match)
      // Example: URL "/featureA/"
      //   req.params.worktree = "featureA"
      //   req.path = "/"
      actualReqPathForVite = req.path;
      // Ensure it starts with a slash, though req.path in this context usually does.
      if (!actualReqPathForVite.startsWith("/")) {
        actualReqPathForVite = "/" + actualReqPathForVite;
      }
      // Normalize if it somehow became '//' (e.g. if req.path was '/' and we prepended another '/')
      if (actualReqPathForVite === "//") actualReqPathForVite = "/";
    } else {
      // This case means the path matched "/:worktree/*" but the 'worktree' param was invalid (e.g., "..") or missing.
      // We should not proceed to create a worktree with an invalid name.
      // Instead, pass to the next middleware. The next middleware should handle 'main' or 404.
      console.warn(
        `[Server] Route /:worktree/* matched, but worktree param '${worktreeFromParam}' is invalid. Original URL: ${req.originalUrl}. Passing to next handler.`
      );
      return next(); // IMPORTANT: Exit this middleware and pass to the next one.
    }

    // Ensure worktree is a non-empty string (guaranteed by logic above)
    if (typeof worktree !== "string" || !worktree) {
      return res.status(400).json({
        error: "Invalid request: Worktree could not be determined or is empty",
      });
    }

    try {
      // Define root and base path variables that will be set based on the branch type
      let rootPathForVite: string;
      let effectiveViteBasePath: string; // To distinguish from viteBasePath set earlier for all valid names

      if (worktree === "main") {
        console.log(
          `[Server] Handling 'main' branch. Using repo path: ${repoPath}`
        );
        rootPathForVite = repoPath;
        effectiveViteBasePath = "/main/"; // Override for main branch

        console.log(`[Server] Running pnpm install in main repo ${repoPath}`);
        try {
          const { stdout: pnpmStdout, stderr: pnpmStderr } = await execCommand(
            "pnpm install",
            repoPath
          );
          console.log(
            `[Server] pnpm install in main repo stdout: ${pnpmStdout}`
          );
          if (pnpmStderr) {
            console.warn(
              `[Server] pnpm install in main repo stderr: ${pnpmStderr}`
            );
          }
        } catch (installError: any) {
          console.error(
            `[Server] Error running pnpm install in main repo: ${
              installError.message || installError.stderr || "Unknown error"
            }`
          );
          // For 'main', if pnpm install fails, we log it but proceed. Vite might fail later if deps are crucial.
        }
        // For 'main', success is implied for "worktree setup" as there's no git worktree operation.
      } else {
        // For non-'main' branches (actual worktrees)
        effectiveViteBasePath = viteBasePath; // viteBasePath is already `/${worktree}/` from earlier logic
        const createWorktreeResult = await createWorktree(worktree, repoPath);

        if (!createWorktreeResult.success) {
          console.error(
            `[Server] Failed to create or prepare worktree '${worktree}': ${createWorktreeResult.message}`
          );
          return res.status(500).json({
            error: `Failed to prepare worktree '${worktree}'`,
            details: createWorktreeResult.message,
          });
        }
        rootPathForVite = path.join(getWorktreesDir(repoPath), worktree);
      }

      // At this point, rootPathForVite and effectiveViteBasePath are set for 'main' or a successful worktree.

      // Create or get Vite server for the worktree (or 'main' using its name as key)
      if (!viteServers[worktree]) {
        console.log(
          `[Server] Creating Vite server for '${worktree}' with base '${effectiveViteBasePath}' and root '${rootPathForVite}'`
        );
        viteServers[worktree] = await vite.createServer({
          root: rootPathForVite, // Use the determined root path
          base: effectiveViteBasePath, // Use the determined base path
          server: {
            middlewareMode: true,
            fs: {
              allow: [repoPath, getWorktreesDir(repoPath)], // Allow main repo and worktrees container
            },
            hmr: {
              server: appServer, // appServer is now guaranteed to be defined
            },
          },
          appType: "custom",
        });
      }

      const server = viteServers[worktree];

      // Try to serve index.html or let Vite handle the request via its middlewares
      try {
        const indexPath = path.resolve(rootPathForVite, "index.html");
        // If index.html exists and it's not explicitly an asset request, transform and serve it.
        const htmlContent = await fs.promises.readFile(indexPath, "utf-8");
        console.log(
          `[Fallback] Serving transformed index.html for '${worktree}'. Original path: '${req.originalUrl}', Vite transform path: '${actualReqPathForVite}'`
        );
        const template = await server.transformIndexHtml(
          actualReqPathForVite, // This is the path within the worktree/main, e.g., / or /sub/path
          htmlContent,
          req.originalUrl
        );
        res.status(200).set({ "Content-Type": "text/html" }).end(template);
      } catch (e: any) {
        // This catch is for errors during index.html processing or Vite transformation
        if (server && typeof server.ssrFixStacktrace === "function") {
          server.ssrFixStacktrace(e);
        }
        console.error(
          `[Fallback] Error during Vite processing/serving index.html for '${worktree}' at ${req.originalUrl}:`,
          e
        );
        next(e); // Pass error to Express error handler or Vite's middleware
      }
    } catch (error: any) {
      // This is the outer catch for the entire middleware operation
      console.error(
        `[Server] Error handling request for ${req.originalUrl}:`,
        error
      );
      res.status(500).json({
        error: `Failed to process request: ${error.message || "Unknown error"}`,
      });
    }
  });

  /*
  // Initialize WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log("Client connected");

    ws.on("message", (message) => {
      console.log(`Received: ${message}`);
      ws.send(`Echo: ${message}`);
    });

    ws.on("close", () => {
      console.log("Client disconnected");
    });
  });

  // Handle termination
  process.on("SIGINT", () => {
    console.log("Shutting down server...");
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });
  */
}

main();

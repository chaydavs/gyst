import { simpleGit, SimpleGit } from "simple-git";
import parseGitDiff from "parse-git-diff";
import { logger } from "../../utils/logger.js";

export interface ParsedCommit {
  type: "error_pattern" | "decision" | "learning";
  title: string;
  content: string;
  files: string[];
}

/**
 * Parses the latest git commit to extract structured knowledge.
 * Supports Conventional Commits: type(scope): subject
 */
export async function parseLatestCommit(workingDir: string): Promise<ParsedCommit | null> {
  const git: SimpleGit = simpleGit(workingDir);
  
  try {
    const log = await git.log({ maxCount: 1 });
    if (log.all.length === 0) return null;
    
    const latest = log.all[0];
    const message = latest.message;
    
    // Regex for Conventional Commits: type(scope): subject
    const conventionalMatch = message.match(/^(\w+)(?:\(([^)]+)\))?\s*:\s*(.*)/);
    if (!conventionalMatch) {
      logger.debug("Commit message does not follow Conventional Commits format", { message });
      return null;
    }
    
    const [, type, scope, subject] = conventionalMatch;
    
    // Get the diff to extract modified files
    const show = await git.show(["--unified=0", latest.hash]);
    const parsedDiff = parseGitDiff(show);
    
    // Extract file paths from the diff
    const files = new Set<string>();
    for (const file of parsedDiff.files) {
      if (file.type === "Added" || file.type === "Deleted" || file.type === "Modified" || file.type === "Renamed") {
        if (file.path) files.add(file.path);
      }
    }

    let entryType: "error_pattern" | "decision" | "learning" = "learning";
    let title = subject.trim();
    if (scope) title = `${scope}: ${title}`;

    if (type === "fix") {
      entryType = "error_pattern";
      // Don't prefix if it's already descriptive
      if (!title.toLowerCase().startsWith("fix")) {
        title = `Fix: ${title}`;
      }
    } else if (type === "feat" || type === "refactor") {
      entryType = "decision";
    }

    return {
      type: entryType,
      title,
      content: `Automated extraction from commit ${latest.hash.slice(0, 7)}.\n\nMessage: ${message}\n\nAuthor: ${latest.author_name} <${latest.author_email}>`,
      files: Array.from(files),
    };
  } catch (err) {
    logger.error("Failed to parse latest commit", { error: err });
    return null;
  }
}

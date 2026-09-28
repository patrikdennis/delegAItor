import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { delegaitorHome } from "../paths.js";
import { transliterate } from "./git.js";

export interface BranchPrefixRule {
  /** e.g. "fix/". */
  prefix: string;
  /** What kind of ticket belongs under this prefix; shown to the agent. */
  description: string;
  /** Words/phrases (any language) that suggest this prefix when found in a ticket. */
  keywords: string[];
}

export interface BranchPrefixRules {
  /** Used when no rule's keywords match. */
  default: string;
  prefixes: BranchPrefixRule[];
  /** Where these rules came from, shown in plan output and the agent prompt. */
  origin: string;
}

export interface PrefixChoice {
  prefix: string;
  /** Human-readable reason, e.g. `matched "bug", "fungerar inte"`. */
  reason: string;
}

/** Filename looked up in `<repo>/.delegaitor/` and `$DELEGAITOR_HOME/`. */
export const BRANCH_PREFIXES_FILE = "branch-prefixes.json";

interface CatalogEntry {
  /** First alias is the canonical spelling. */
  aliases: string[];
  description: string;
  keywords: string[];
}

/**
 * Common branch types (conventional-commit style), with English and Swedish
 * keywords. Aliases let repo detection recognize e.g. `bugfix/` as the fix
 * type and reuse its keywords.
 */
const CATALOG: CatalogEntry[] = [
  {
    aliases: ["fix/", "bugfix/", "bug/"],
    description: "A bug fix: existing behavior that doesn't work as intended",
    keywords: [
      "bug", "bugs", "fix", "fixes", "fixed", "broken", "error", "errors", "crash", "crashes", "fails", "failing",
      "incorrect", "wrong", "regression", "doesn't work", "does not work", "not working",
      "bugg", "buggen", "fel", "felet", "felaktig", "felaktigt", "fungerar inte", "funkar inte", "trasig",
      "trasigt", "krasch", "blir fel", "visas inte", "syns inte", "fungerar ej", "funkar ej", "inga träffar",
      "ingen träff", "hittar inte", "försvinner", "går inte att",
    ],
  },
  {
    aliases: ["hotfix/"],
    description: "An urgent fix that has to go to production immediately",
    keywords: ["hotfix", "urgent", "production down", "outage", "akut", "brådskande"],
  },
  {
    aliases: ["security/", "sec/"],
    description: "A security fix or hardening",
    keywords: ["security", "vulnerability", "cve", "xss", "csrf", "injection", "säkerhet", "sårbarhet"],
  },
  {
    aliases: ["perf/"],
    description: "A performance improvement without behavior changes",
    keywords: [
      "performance", "slow", "speed up", "optimize", "optimise", "latency",
      "prestanda", "snabba upp", "långsam", "långsamt", "tar tid",
    ],
  },
  {
    aliases: ["refactor/"],
    description: "Restructuring code without changing behavior",
    keywords: ["refactor", "refactoring", "clean up", "cleanup", "restructure", "simplify", "refaktorera", "refaktorering", "städa", "omstrukturera"],
  },
  {
    aliases: ["docs/", "doc/"],
    description: "Documentation-only changes",
    keywords: ["docs", "documentation", "readme", "dokumentation", "dokumentera"],
  },
  {
    aliases: ["test/", "tests/"],
    description: "Adding or fixing tests only",
    keywords: ["unit test", "unit tests", "test coverage", "add tests", "e2e", "enhetstest", "enhetstester", "testfall"],
  },
  {
    aliases: ["chore/"],
    description: "Maintenance: dependency bumps, configuration, tooling",
    keywords: ["chore", "bump", "upgrade", "dependency", "dependencies", "deps", "uppgradera", "beroenden"],
  },
  {
    aliases: ["ci/", "build/"],
    description: "CI pipelines and build configuration",
    keywords: ["ci", "pipeline", "github actions", "workflow file", "build script"],
  },
  {
    aliases: ["feature/", "feat/"],
    description: "New functionality, or an enhancement to existing functionality",
    keywords: [
      "add", "adds", "new", "support for", "implement", "introduce", "allow", "enable", "feature",
      "lägg till", "lägga till", "ny", "nytt", "nya", "stöd för", "möjlighet", "införa",
    ],
  },
];

const DEFAULT_PREFIX = "feature/";

function catalogFor(prefix: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.aliases.includes(prefix));
}

/**
 * Resolves which branch prefixes apply to a repo, in priority order:
 * 1. an explicit rules file (`--branch-rules`),
 * 2. `<repo>/.delegaitor/branch-prefixes.json` (shared with the team),
 * 3. `$DELEGAITOR_HOME/branch-prefixes.json` (your personal default),
 * 4. prefixes already used by the repo's remote branches,
 * 5. a built-in conventional set.
 */
export async function loadBranchPrefixRules(repoPath: string, rulesFile?: string): Promise<BranchPrefixRules> {
  const candidates = [
    rulesFile,
    join(repoPath, ".delegaitor", BRANCH_PREFIXES_FILE),
    join(delegaitorHome(), BRANCH_PREFIXES_FILE),
  ].filter((p): p is string => !!p);
  for (const path of candidates) {
    if (path === rulesFile || existsSync(path)) return parseRulesFile(path);
  }

  const detected = await detectRepoPrefixes(repoPath);
  if (detected.length) {
    return {
      default: detected.includes(DEFAULT_PREFIX) ? DEFAULT_PREFIX : detected[0],
      prefixes: detected.map((prefix) => {
        const c = catalogFor(prefix)!;
        return { prefix, description: c.description, keywords: c.keywords };
      }),
      origin: `prefixes already used by this repo's branches (${detected.join(", ")})`,
    };
  }

  return {
    default: DEFAULT_PREFIX,
    prefixes: CATALOG.map((c) => ({ prefix: c.aliases[0], description: c.description, keywords: c.keywords })),
    origin: "built-in conventional prefixes",
  };
}

function parseRulesFile(path: string): BranchPrefixRules {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read branch prefix rules ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const data = raw as { default?: string; prefixes?: Partial<BranchPrefixRule>[] };
  if (!Array.isArray(data.prefixes) || !data.prefixes.length) {
    throw new Error(`${path}: expected a non-empty "prefixes" array.`);
  }
  const prefixes = data.prefixes.map((p, i) => {
    if (!p.prefix || typeof p.prefix !== "string") throw new Error(`${path}: prefixes[${i}] is missing "prefix".`);
    const prefix = normalizePrefix(p.prefix);
    const known = catalogFor(prefix);
    return {
      prefix,
      description: p.description ?? known?.description ?? "",
      // Keywords are optional for well-known prefixes, which reuse the built-in ones.
      keywords: p.keywords ?? known?.keywords ?? [],
    };
  });
  const def = normalizePrefix(data.default ?? prefixes[0].prefix);
  if (!prefixes.some((p) => p.prefix === def)) {
    throw new Error(`${path}: "default" (${def}) must be one of the listed prefixes.`);
  }
  return { default: def, prefixes, origin: path };
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  return trimmed && !trimmed.endsWith("/") ? `${trimmed}/` : trimmed;
}

/**
 * Finds which catalog branch types a repo already uses, based on its remote
 * branch names (local ones as fallback), picking the repo's most used
 * spelling for each type (e.g. `fix/` over `bug/`). Bot/tool prefixes like
 * `dependabot/` aren't in the catalog, so they're ignored.
 */
async function detectRepoPrefixes(repoPath: string): Promise<string[]> {
  const refs = async (namespace: string, strip: number) => {
    const { stdout } = await execa("git", ["for-each-ref", `--format=%(refname:lstrip=${strip})`, namespace], {
      cwd: repoPath,
    }).catch(() => ({ stdout: "" }));
    return stdout.split("\n").filter(Boolean);
  };
  let names = await refs("refs/remotes/origin", 3);
  if (!names.length) names = await refs("refs/heads", 2);

  const counts = new Map<string, number>();
  for (const name of names) {
    const slash = name.indexOf("/");
    if (slash <= 0) continue;
    const prefix = name.slice(0, slash + 1);
    if (catalogFor(prefix)) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }

  const chosen: string[] = [];
  for (const entry of CATALOG) {
    const used = entry.aliases
      .map((alias) => ({ alias, n: counts.get(alias) ?? 0 }))
      .filter((a) => a.n > 0)
      .sort((a, b) => b.n - a.n);
    if (used.length) chosen.push(used[0].alias);
  }
  return chosen;
}

/**
 * Picks a prefix by counting keyword matches, weighting the title higher
 * than the body. This is only a first guess made before any agent has read
 * the ticket; the agent is asked to rename the branch if it doesn't fit.
 */
export function classifyBranchPrefix(
  ticket: { title: string; body?: string },
  rules: BranchPrefixRules,
): PrefixChoice {
  const title = normalizeText(ticket.title);
  const body = normalizeText(ticket.body ?? "");

  let best: { rule: BranchPrefixRule; score: number; matched: string[] } | undefined;
  for (const rule of rules.prefixes) {
    let score = 0;
    const matched: string[] = [];
    for (const kw of rule.keywords) {
      const re = keywordRegex(kw);
      const inTitle = re.test(title);
      const inBody = re.test(body);
      if (inTitle || inBody) {
        score += (inTitle ? 3 : 0) + (inBody ? 1 : 0);
        matched.push(kw);
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { rule, score, matched };
  }

  if (!best) return { prefix: rules.default, reason: "no keywords matched, used the default" };
  const shown = best.matched.slice(0, 3).map((m) => `"${m}"`).join(", ");
  return { prefix: best.rule.prefix, reason: `matched ${shown}` };
}

function normalizeText(text: string): string {
  return transliterate(text).toLowerCase();
}

/** Short keywords must match a whole word; longer ones may be followed by a suffix (e.g. "refactor" → "refactoring"). */
function keywordRegex(keyword: string): RegExp {
  const kw = normalizeText(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = kw.length >= 4 ? "" : "(?![a-z0-9])";
  return new RegExp(`(?:^|[^a-z0-9])${kw}${end}`);
}

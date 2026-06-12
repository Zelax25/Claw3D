// Gitea provider for the Code Review Room.
//
// Mirrors the exported shapes of ./github.ts (GitHubDashboardResponse /
// GitHubDetailResponse / review + inline-comment submitters) so the office UI
// and API route can treat GitHub and Gitea interchangeably via a `provider`
// switch. Unlike github.ts (which shells out to the `gh` CLI), this talks to the
// Gitea REST API directly with fetch() — no extra binaries in the container.
//
// Config (env):
//   GITEA_BASE_URL  default https://git.zelaxholdings.com/api/v1
//   GITEA_TOKEN     personal access token (Authorization: token <PAT>)

import type {
  GitHubAuthState,
  GitHubCommentEntry,
  GitHubCommitEntry,
  GitHubDashboardResponse,
  GitHubDetailResponse,
  GitHubFileEntry,
  GitHubInlineCommentSide,
  GitHubPullRequestDetail,
  GitHubPullRequestSummary,
  GitHubReviewAction,
  GitHubReviewEntry,
  GitHubStatusCheck,
} from "./github";

const DEFAULT_BASE_URL = "https://git.zelaxholdings.com/api/v1";
const DIFF_PREVIEW_LIMIT = 80_000;

const resolveBaseUrl = (): string => {
  const raw = (process.env.GITEA_BASE_URL ?? "").trim();
  const base = raw || DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "");
};

const resolveToken = (): string | null => {
  const token = (process.env.GITEA_TOKEN ?? "").trim();
  return token ? token : null;
};

// ── small value coercion helpers (mirrors github.ts conventions) ────────────

const trimText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const toNumber = (value: unknown): number => {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const toRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
};

const toArray = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : [];
};

// ── fetch plumbing ──────────────────────────────────────────────────────────

class GiteaRequestError extends Error {}

const buildHeaders = (token: string, accept = "application/json"): HeadersInit => ({
  Authorization: `token ${token}`,
  Accept: accept,
});

const extractErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const text = await response.text();
    if (!text.trim()) return fallback;
    try {
      const payload = JSON.parse(text) as { message?: unknown };
      const message = trimText(payload.message);
      if (message) return message;
    } catch {
      // not JSON — fall back to raw text below
    }
    return text.trim().slice(0, 300);
  } catch {
    return fallback;
  }
};

const giteaGetJson = async <T>(token: string, path: string, label: string): Promise<T> => {
  const response = await fetch(`${resolveBaseUrl()}${path}`, {
    headers: buildHeaders(token),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new GiteaRequestError(
      await extractErrorMessage(response, `Failed to load ${label}.`),
    );
  }
  return (await response.json()) as T;
};

const giteaGetText = async (token: string, path: string, label: string): Promise<string> => {
  const response = await fetch(`${resolveBaseUrl()}${path}`, {
    headers: buildHeaders(token, "text/plain"),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new GiteaRequestError(
      await extractErrorMessage(response, `Failed to load ${label}.`),
    );
  }
  return await response.text();
};

const giteaPostJson = async (
  token: string,
  path: string,
  body: unknown,
  label: string,
): Promise<void> => {
  const response = await fetch(`${resolveBaseUrl()}${path}`, {
    method: "POST",
    headers: { ...buildHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new GiteaRequestError(
      await extractErrorMessage(response, `Failed to ${label}.`),
    );
  }
};

// "owner/repo" → { owner, repo }. Gitea repo names cannot contain "/", so the
// first segment is always the owner.
const splitRepo = (slug: string): { owner: string; repo: string } => {
  const trimmed = slug.trim();
  const index = trimmed.indexOf("/");
  if (index <= 0 || index >= trimmed.length - 1) {
    throw new GiteaRequestError(`Invalid repository "${slug}" — expected owner/repo.`);
  }
  return { owner: trimmed.slice(0, index), repo: trimmed.slice(index + 1) };
};

const encodeRepoPath = (slug: string): string => {
  const { owner, repo } = splitRepo(slug);
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
};

// ── normalizers ─────────────────────────────────────────────────────────────

const normalizeLabels = (value: unknown): string[] => {
  return toArray(value)
    .map((entry) => trimText(toRecord(entry).name) ?? trimText(entry))
    .filter((entry): entry is string => Boolean(entry));
};

const isDraftFrom = (record: Record<string, unknown>): boolean => {
  if (typeof record.draft === "boolean") return record.draft;
  const pull = toRecord(record.pull_request);
  return typeof pull.draft === "boolean" ? pull.draft : false;
};

const mergeableLabel = (value: unknown): string | null => {
  if (value === true) return "MERGEABLE";
  if (value === false) return "CONFLICTING";
  return null;
};

// Used for /repos/issues/search hits (Issue shape: repository.full_name, html_url).
const normalizeIssueSummary = (value: unknown): GitHubPullRequestSummary => {
  const record = toRecord(value);
  const repo =
    trimText(toRecord(record.repository).full_name) ??
    trimText(record.repo) ??
    "unknown/unknown";
  return {
    number: toNumber(record.number),
    title: trimText(record.title) ?? "Untitled pull request",
    url: trimText(record.html_url) ?? "",
    repo,
    author: trimText(toRecord(record.user).login) ?? "unknown",
    updatedAt: trimText(record.updated_at),
    isDraft: isDraftFrom(record),
    labels: normalizeLabels(record.labels),
    reviewDecision: null,
    headRefName: trimText(toRecord(record.head).ref),
    baseRefName: trimText(toRecord(record.base).ref),
    statusSummary: null,
  };
};

// Used for the full PullRequest payload.
const normalizePullSummary = (
  value: unknown,
  fallbackRepo: string,
): GitHubPullRequestSummary => {
  const record = toRecord(value);
  const repo =
    trimText(toRecord(record.base).repo) ??
    trimText(toRecord(toRecord(record.base).repo).full_name) ??
    fallbackRepo;
  return {
    number: toNumber(record.number),
    title: trimText(record.title) ?? "Untitled pull request",
    url: trimText(record.html_url) ?? "",
    repo: repo ?? fallbackRepo,
    author: trimText(toRecord(record.user).login) ?? "unknown",
    updatedAt: trimText(record.updated_at),
    isDraft: isDraftFrom(record),
    labels: normalizeLabels(record.labels),
    reviewDecision: null,
    headRefName: trimText(toRecord(record.head).ref),
    baseRefName: trimText(toRecord(record.base).ref),
    statusSummary: null,
  };
};

const normalizeFiles = (value: unknown): GitHubFileEntry[] => {
  return toArray(value).map((entry) => {
    const record = toRecord(entry);
    return {
      path: trimText(record.filename) ?? trimText(record.path) ?? "unknown",
      additions: toNumber(record.additions),
      deletions: toNumber(record.deletions),
      status: trimText(record.status),
      previousPath: trimText(record.previous_filename),
      // Gitea's files endpoint does not return per-file patches; the full diff
      // (loaded separately) carries the hunks.
      patch: null,
    };
  });
};

const normalizeReviews = (value: unknown): GitHubReviewEntry[] => {
  return toArray(value)
    .map((entry) => {
      const record = toRecord(entry);
      return {
        author: trimText(toRecord(record.user).login) ?? "unknown",
        state: trimText(record.state),
        body: trimText(record.body) ?? "",
        submittedAt: trimText(record.submitted_at),
      };
    })
    // Drop Gitea's pending/empty placeholder reviews.
    .filter((review) => review.state !== "PENDING" || review.body);
};

const normalizeComments = (value: unknown): GitHubCommentEntry[] => {
  return toArray(value).map((entry) => {
    const record = toRecord(entry);
    return {
      author: trimText(toRecord(record.user).login) ?? "unknown",
      body: trimText(record.body) ?? "",
      createdAt: trimText(record.created_at),
      url: trimText(record.html_url),
    };
  });
};

const normalizeCommits = (value: unknown): GitHubCommitEntry[] => {
  return toArray(value).map((entry) => {
    const record = toRecord(entry);
    const message = trimText(toRecord(record.commit).message) ?? "Commit";
    return {
      oid: trimText(record.sha) ?? "",
      messageHeadline: message.split("\n")[0] ?? "Commit",
      authoredDate: trimText(record.created),
    };
  });
};

const summarizeStatuses = (statuses: GitHubStatusCheck[]): string | null => {
  if (statuses.length === 0) return null;
  let failed = 0;
  let pending = 0;
  let passed = 0;
  for (const status of statuses) {
    const state = (status.status ?? "").toUpperCase();
    if (state === "FAILURE" || state === "ERROR") failed += 1;
    else if (state === "PENDING") pending += 1;
    else if (state === "SUCCESS") passed += 1;
  }
  if (failed > 0) return `${failed} failing`;
  if (pending > 0) return `${pending} pending`;
  if (passed > 0) return `${passed} passing`;
  return null;
};

const loadStatusChecks = async (
  token: string,
  repoPath: string,
  sha: string | null,
): Promise<GitHubStatusCheck[]> => {
  if (!sha) return [];
  try {
    const payload = await giteaGetJson<Record<string, unknown>>(
      token,
      `/repos/${repoPath}/commits/${encodeURIComponent(sha)}/status`,
      "commit status",
    );
    return toArray(payload.statuses).map((entry) => {
      const record = toRecord(entry);
      return {
        name: trimText(record.context) ?? "Status check",
        status: trimText(record.status),
        conclusion: null,
        workflow: null,
        detailsUrl: trimText(record.target_url),
      };
    });
  } catch {
    return [];
  }
};

// ── auth ────────────────────────────────────────────────────────────────────

type GiteaAuth = {
  authState: GitHubAuthState;
  viewerLogin: string | null;
  message: string | null;
  token: string | null;
};

const getGiteaAuthState = async (): Promise<GiteaAuth> => {
  const token = resolveToken();
  if (!token) {
    return {
      authState: "unauthenticated",
      viewerLogin: null,
      message: "Gitea token is not configured (set GITEA_TOKEN).",
      token: null,
    };
  }
  try {
    const user = await giteaGetJson<{ login?: unknown }>(token, "/user", "Gitea user");
    return {
      authState: "ready",
      viewerLogin: trimText(user.login),
      message: null,
      token,
    };
  } catch (error) {
    return {
      authState: "unauthenticated",
      viewerLogin: null,
      message:
        error instanceof Error ? error.message : "Gitea token is not valid.",
      token: null,
    };
  }
};

// ── public API (mirrors github.ts) ──────────────────────────────────────────

const searchPullRequests = async (
  token: string,
  filter: "review_requested" | "created",
): Promise<GitHubPullRequestSummary[]> => {
  const payload = await giteaGetJson<unknown[]>(
    token,
    `/repos/issues/search?type=pulls&state=open&${filter}=true&limit=25`,
    `Gitea ${filter} pull requests`,
  );
  return toArray(payload).map(normalizeIssueSummary);
};

export const loadGiteaDashboard = async (): Promise<GitHubDashboardResponse> => {
  const auth = await getGiteaAuthState();
  if (auth.authState !== "ready" || !auth.token) {
    return {
      ready: false,
      authState: auth.authState,
      viewerLogin: auth.viewerLogin,
      currentRepoSlug: null,
      currentRepoPullRequests: [],
      reviewRequests: [],
      authoredPullRequests: [],
      message: auth.message,
    };
  }

  const [reviewRequests, authoredPullRequests] = await Promise.all([
    searchPullRequests(auth.token, "review_requested").catch(() => []),
    searchPullRequests(auth.token, "created").catch(() => []),
  ]);

  return {
    ready: true,
    authState: auth.authState,
    viewerLogin: auth.viewerLogin,
    // Gitea has no "current local repo" the way the GitHub provider derives one
    // from `git remote`; the queue (review-requested + authored) is the surface.
    currentRepoSlug: null,
    currentRepoPullRequests: [],
    reviewRequests,
    authoredPullRequests,
    message: null,
  };
};

const loadPullRequestDiff = async (
  token: string,
  repoPath: string,
  number: number,
): Promise<{ diff: string; diffTruncated: boolean }> => {
  try {
    const output = await giteaGetText(
      token,
      `/repos/${repoPath}/pulls/${number}.diff`,
      "pull request diff",
    );
    const diff = output.trimEnd();
    if (diff.length <= DIFF_PREVIEW_LIMIT) {
      return { diff, diffTruncated: false };
    }
    return {
      diff: `${diff.slice(0, DIFF_PREVIEW_LIMIT).trimEnd()}\n\n... diff truncated ...`,
      diffTruncated: true,
    };
  } catch {
    return { diff: "", diffTruncated: false };
  }
};

const loadPullRequestDetail = async (
  token: string,
  repo: string,
  number: number,
): Promise<GitHubPullRequestDetail> => {
  const repoPath = encodeRepoPath(repo);
  const payload = await giteaGetJson<Record<string, unknown>>(
    token,
    `/repos/${repoPath}/pulls/${number}`,
    "pull request",
  );

  const headSha = trimText(toRecord(payload.head).sha);
  const [files, reviews, comments, commits, statusChecks, diff] = await Promise.all([
    giteaGetJson<unknown[]>(token, `/repos/${repoPath}/pulls/${number}/files?limit=100`, "files")
      .then(normalizeFiles)
      .catch(() => []),
    giteaGetJson<unknown[]>(token, `/repos/${repoPath}/pulls/${number}/reviews`, "reviews")
      .then(normalizeReviews)
      .catch(() => []),
    giteaGetJson<unknown[]>(token, `/repos/${repoPath}/issues/${number}/comments`, "comments")
      .then(normalizeComments)
      .catch(() => []),
    giteaGetJson<unknown[]>(token, `/repos/${repoPath}/pulls/${number}/commits`, "commits")
      .then(normalizeCommits)
      .catch(() => []),
    loadStatusChecks(token, repoPath, headSha),
    loadPullRequestDiff(token, repoPath, number),
  ]);

  const summary = normalizePullSummary(payload, repo);
  return {
    ...summary,
    statusSummary: summarizeStatuses(statusChecks),
    body: trimText(payload.body) ?? "",
    state: trimText(payload.state),
    mergeable: mergeableLabel(payload.mergeable),
    headRefOid: headSha,
    statusChecks,
    reviews,
    comments,
    commits,
    files,
    diff: diff.diff,
    diffTruncated: diff.diffTruncated,
  };
};

export const loadGiteaPullRequestDetail = async (params: {
  repo: string;
  number: number;
}): Promise<GitHubDetailResponse> => {
  const auth = await getGiteaAuthState();
  if (auth.authState !== "ready" || !auth.token) {
    return {
      ready: false,
      authState: auth.authState,
      viewerLogin: auth.viewerLogin,
      currentRepoSlug: null,
      pullRequest: null,
      message: auth.message,
    };
  }
  return {
    ready: true,
    authState: auth.authState,
    viewerLogin: auth.viewerLogin,
    currentRepoSlug: null,
    pullRequest: await loadPullRequestDetail(auth.token, params.repo, params.number),
    message: null,
  };
};

const reviewEvent = (action: GitHubReviewAction): "APPROVED" | "COMMENT" | "REQUEST_CHANGES" => {
  if (action === "APPROVE") return "APPROVED";
  if (action === "REQUEST_CHANGES") return "REQUEST_CHANGES";
  return "COMMENT";
};

export const submitGiteaPullRequestReview = async (params: {
  repo: string;
  number: number;
  action: GitHubReviewAction;
  body?: string | null;
}): Promise<{ ok: true; message: string }> => {
  const auth = await getGiteaAuthState();
  if (auth.authState !== "ready" || !auth.token) {
    throw new Error(auth.message ?? "Gitea token is not ready.");
  }

  const body =
    params.body?.trim() ||
    (params.action === "COMMENT"
      ? "Reviewed in Claw3D."
      : params.action === "REQUEST_CHANGES"
        ? "Please address the requested updates from Claw3D."
        : "");

  await giteaPostJson(
    auth.token,
    `/repos/${encodeRepoPath(params.repo)}/pulls/${params.number}/reviews`,
    { event: reviewEvent(params.action), body },
    "submit the Gitea review",
  );

  return {
    ok: true,
    message:
      params.action === "APPROVE"
        ? "Pull request approved."
        : params.action === "REQUEST_CHANGES"
          ? "Requested changes on pull request."
          : "Review comment submitted.",
  };
};

export const submitGiteaInlineComment = async (params: {
  repo: string;
  number: number;
  path: string;
  line: number;
  side: GitHubInlineCommentSide;
  body: string;
  commitId?: string | null;
}): Promise<{ ok: true; message: string }> => {
  const auth = await getGiteaAuthState();
  if (auth.authState !== "ready" || !auth.token) {
    throw new Error(auth.message ?? "Gitea token is not ready.");
  }

  const trimmedBody = params.body.trim();
  if (!trimmedBody) {
    throw new Error("Comment body is required.");
  }

  // Gitea carries inline comments inside a review submission. LEFT (old) vs
  // RIGHT (new) maps to old_position / new_position.
  const comment =
    params.side === "LEFT"
      ? { path: params.path, body: trimmedBody, old_position: params.line }
      : { path: params.path, body: trimmedBody, new_position: params.line };

  await giteaPostJson(
    auth.token,
    `/repos/${encodeRepoPath(params.repo)}/pulls/${params.number}/reviews`,
    { event: "COMMENT", body: "", comments: [comment] },
    "submit the Gitea inline comment",
  );

  return { ok: true, message: "Inline comment submitted." };
};

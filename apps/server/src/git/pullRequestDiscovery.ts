import { Effect } from "effect";
import type { GitCommandError, GitHubCliError } from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

import type { GitCoreShape } from "./Services/GitCore.ts";
import type { GitHubCliShape, GitHubPullRequestSummary } from "./Services/GitHubCli.ts";
import { extractBranchNameFromRemoteRef } from "./remoteRefs.ts";

const MAX_DISCOVERED_PULL_REQUESTS = 5;

export interface PullRequestHeadRemoteInfo {
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface BranchHeadContext {
  readonly localBranch: string;
  readonly headBranch: string;
  readonly headSelectors: ReadonlyArray<string>;
  readonly preferredHeadSelector: string;
  readonly remoteName: string | null;
  readonly trackingRemoteName: string | null;
  readonly headRepositoryNameWithOwner: string | null;
  readonly headRepositoryOwnerLogin: string | null;
  readonly isCrossRepository: boolean;
}

export interface DiscoveredPullRequest extends PullRequestHeadRemoteInfo {
  readonly repository: string;
  readonly repositoryPriority: number;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: string | null;
}

interface RemoteRepositoryContext {
  readonly repositoryNameWithOwner: string | null;
  readonly ownerLogin: string | null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalRepositoryNameWithOwner(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalOwnerLogin(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function parseRepositoryOwnerLogin(nameWithOwner: string | null): string | null {
  const trimmed = nameWithOwner?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  const [ownerLogin] = trimmed.split("/");
  const normalizedOwnerLogin = ownerLogin?.trim() ?? "";
  return normalizedOwnerLogin.length > 0 ? normalizedOwnerLogin : null;
}

function parseRepositoryNameFromPullRequestUrl(url: string): string | null {
  const trimmed = url.trim();
  const match = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/\d+(?:\/.*)?$/i.exec(trimmed);
  const repositoryName = match?.[1]?.trim() ?? "";
  return repositoryName.length > 0 ? repositoryName : null;
}

function resolvePullRequestHeadRepositoryNameWithOwner(
  pr: PullRequestHeadRemoteInfo & { url: string },
): string | null {
  const explicitRepository = normalizeOptionalString(pr.headRepositoryNameWithOwner);
  if (explicitRepository) {
    return explicitRepository;
  }

  if (!pr.isCrossRepository) {
    return null;
  }

  const ownerLogin = normalizeOptionalString(pr.headRepositoryOwnerLogin);
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pr.url);
  if (!ownerLogin || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

function appendUnique(values: string[], next: string | null | undefined): void {
  const trimmed = next?.trim() ?? "";
  if (trimmed.length === 0 || values.includes(trimmed)) {
    return;
  }
  values.push(trimmed);
}

function matchesBranchHeadContext(
  pr: PullRequestHeadRemoteInfo & {
    headRefName: string;
    url: string;
  },
  headContext: Pick<
    BranchHeadContext,
    "headBranch" | "headRepositoryNameWithOwner" | "headRepositoryOwnerLogin" | "isCrossRepository"
  >,
): boolean {
  if (pr.headRefName !== headContext.headBranch) {
    return false;
  }

  const expectedHeadRepository = normalizeOptionalRepositoryNameWithOwner(
    headContext.headRepositoryNameWithOwner,
  );
  const expectedHeadOwner =
    normalizeOptionalOwnerLogin(headContext.headRepositoryOwnerLogin) ??
    parseRepositoryOwnerLogin(expectedHeadRepository);
  const prHeadRepository = normalizeOptionalRepositoryNameWithOwner(
    resolvePullRequestHeadRepositoryNameWithOwner(pr),
  );
  const prHeadOwner =
    normalizeOptionalOwnerLogin(pr.headRepositoryOwnerLogin) ??
    parseRepositoryOwnerLogin(prHeadRepository);

  if (headContext.isCrossRepository) {
    if (pr.isCrossRepository === false) {
      return false;
    }
    if ((expectedHeadRepository || expectedHeadOwner) && !prHeadRepository && !prHeadOwner) {
      return false;
    }
    if (expectedHeadRepository && prHeadRepository && expectedHeadRepository !== prHeadRepository) {
      return false;
    }
    if (expectedHeadOwner && prHeadOwner && expectedHeadOwner !== prHeadOwner) {
      return false;
    }
    return true;
  }

  if (pr.isCrossRepository === true) {
    return false;
  }
  if (expectedHeadRepository && prHeadRepository && expectedHeadRepository !== prHeadRepository) {
    return false;
  }
  if (expectedHeadOwner && prHeadOwner && expectedHeadOwner !== prHeadOwner) {
    return false;
  }
  return true;
}

function stateSortWeight(state: "open" | "closed" | "merged"): number {
  switch (state) {
    case "open":
      return 0;
    case "merged":
      return 1;
    case "closed":
      return 2;
  }
}

function toDiscoveredPullRequest(
  repository: string,
  repositoryPriority: number,
  summary: GitHubPullRequestSummary,
): DiscoveredPullRequest {
  return {
    repository,
    repositoryPriority,
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
    updatedAt: summary.updatedAt ?? null,
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

function normalizeRepositoryKey(repository: string): string {
  return repository.trim().toLowerCase();
}

function normalizePullRequestKey(repository: string, number: number): string {
  return `${normalizeRepositoryKey(repository)}#${number}`;
}

function parseRemoteConfigOutput(
  stdout: string,
): ReadonlyArray<{ remoteName: string; url: string }> {
  return stdout
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return null;
      }
      const match = /^remote\.(.+)\.url\s+(.+)$/.exec(trimmed);
      if (!match) {
        return null;
      }
      const remoteName = match[1]?.trim() ?? "";
      const url = match[2]?.trim() ?? "";
      if (remoteName.length === 0 || url.length === 0) {
        return null;
      }
      return { remoteName, url };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
}

export function resolveBranchHeadContext(input: {
  cwd: string;
  branch: string;
  upstreamRef: string | null;
  gitCore: GitCoreShape;
  gitHubCli: GitHubCliShape;
}): Effect.Effect<BranchHeadContext, GitCommandError | GitHubCliError> {
  const readConfigValueNullable = (key: string) =>
    input.gitCore.readConfigValue(input.cwd, key).pipe(Effect.catch(() => Effect.succeed(null)));

  const resolveRemoteRepositoryContext = (
    remoteName: string | null,
  ): Effect.Effect<RemoteRepositoryContext, GitCommandError> =>
    Effect.gen(function* () {
      if (!remoteName) {
        return {
          repositoryNameWithOwner: null,
          ownerLogin: null,
        };
      }

      const remoteUrl = yield* readConfigValueNullable(`remote.${remoteName}.url`);
      const repositoryNameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
      return {
        repositoryNameWithOwner,
        ownerLogin: parseRepositoryOwnerLogin(repositoryNameWithOwner),
      };
    });

  return Effect.gen(function* () {
    const trackingRemoteName = yield* readConfigValueNullable(`branch.${input.branch}.remote`);
    const remoteName =
      (yield* readConfigValueNullable(`branch.${input.branch}.pushRemote`)) ?? trackingRemoteName;
    const headBranchFromUpstream = input.upstreamRef
      ? extractBranchNameFromRemoteRef(input.upstreamRef, { remoteName: trackingRemoteName })
      : "";
    const headBranch = headBranchFromUpstream.length > 0 ? headBranchFromUpstream : input.branch;
    const shouldProbeLocalBranchSelector =
      headBranchFromUpstream.length === 0 || headBranch === input.branch;

    const [remoteRepository, originRepository] = yield* Effect.all(
      [resolveRemoteRepositoryContext(remoteName), resolveRemoteRepositoryContext("origin")],
      { concurrency: "unbounded" },
    );

    const isCrossRepository =
      remoteRepository.repositoryNameWithOwner !== null &&
      originRepository.repositoryNameWithOwner !== null
        ? remoteRepository.repositoryNameWithOwner.toLowerCase() !==
          originRepository.repositoryNameWithOwner.toLowerCase()
        : remoteName !== null &&
          remoteName !== "origin" &&
          remoteRepository.repositoryNameWithOwner !== null;

    const ownerHeadSelector =
      remoteRepository.ownerLogin && headBranch.length > 0
        ? `${remoteRepository.ownerLogin}:${headBranch}`
        : null;
    const remoteAliasHeadSelector =
      remoteName && headBranch.length > 0 ? `${remoteName}:${headBranch}` : null;
    const shouldProbeRemoteOwnedSelectors =
      isCrossRepository || (remoteName !== null && remoteName !== "origin");

    const headSelectors: string[] = [];
    if (isCrossRepository && shouldProbeRemoteOwnedSelectors) {
      appendUnique(headSelectors, ownerHeadSelector);
      appendUnique(
        headSelectors,
        remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
      );
    }
    if (shouldProbeLocalBranchSelector) {
      appendUnique(headSelectors, input.branch);
    }
    appendUnique(headSelectors, headBranch !== input.branch ? headBranch : null);
    if (!isCrossRepository && shouldProbeRemoteOwnedSelectors) {
      appendUnique(headSelectors, ownerHeadSelector);
      appendUnique(
        headSelectors,
        remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
      );
    }

    return {
      localBranch: input.branch,
      headBranch,
      headSelectors,
      preferredHeadSelector:
        ownerHeadSelector && isCrossRepository ? ownerHeadSelector : headBranch,
      remoteName,
      trackingRemoteName,
      headRepositoryNameWithOwner: remoteRepository.repositoryNameWithOwner,
      headRepositoryOwnerLogin: remoteRepository.ownerLogin,
      isCrossRepository,
    } satisfies BranchHeadContext;
  });
}

export function discoverPullRequestsForBranch(input: {
  cwd: string;
  branch: string;
  upstreamRef: string | null;
  gitCore: GitCoreShape;
  gitHubCli: GitHubCliShape;
  limit?: number;
}): Effect.Effect<ReadonlyArray<DiscoveredPullRequest>, GitCommandError | GitHubCliError> {
  const readConfigValueNullable = (key: string) =>
    input.gitCore.readConfigValue(input.cwd, key).pipe(Effect.catch(() => Effect.succeed(null)));

  const resolveRepositoryFromRemoteName = (
    remoteName: string | null,
  ): Effect.Effect<string | null, GitCommandError> =>
    Effect.gen(function* () {
      if (!remoteName) {
        return null;
      }
      const remoteUrl = yield* readConfigValueNullable(`remote.${remoteName}.url`);
      return parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
    });

  const resolveCandidateRepositories = (): Effect.Effect<
    ReadonlyArray<string>,
    GitCommandError | GitHubCliError
  > =>
    Effect.gen(function* () {
      const trackingRemoteName = yield* readConfigValueNullable(`branch.${input.branch}.remote`);
      const primaryRemoteName =
        (yield* readConfigValueNullable(`branch.${input.branch}.pushRemote`)) ?? trackingRemoteName;
      const primaryRepository = yield* resolveRepositoryFromRemoteName(primaryRemoteName);
      const originRepository = yield* resolveRepositoryFromRemoteName("origin");
      const ghRepository = yield* input.gitHubCli
        .getRepositoryNameWithOwner({ cwd: input.cwd })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const remoteConfig = yield* input.gitCore.execute({
        operation: "PullRequestDiscovery.resolveCandidateRepositories.listRemotes",
        cwd: input.cwd,
        args: ["config", "--get-regexp", "^remote\\..*\\.url$"],
        allowNonZeroExit: true,
      });

      const repositories: string[] = [];
      appendUnique(repositories, primaryRepository);
      appendUnique(repositories, originRepository);
      appendUnique(repositories, ghRepository);
      for (const entry of parseRemoteConfigOutput(remoteConfig.stdout)) {
        appendUnique(repositories, parseGitHubRepositoryNameWithOwnerFromRemoteUrl(entry.url));
      }
      return repositories;
    });

  return Effect.gen(function* () {
    const headContext = yield* resolveBranchHeadContext(input);
    const candidateRepositories = yield* resolveCandidateRepositories();
    const repositoryPriority = new Map(
      candidateRepositories.map((repository, index) => [normalizeRepositoryKey(repository), index]),
    );
    const found = new Map<string, DiscoveredPullRequest>();

    for (const repository of candidateRepositories) {
      const priority =
        repositoryPriority.get(normalizeRepositoryKey(repository)) ?? Number.MAX_SAFE_INTEGER;
      for (const headSelector of headContext.headSelectors) {
        const pullRequests = yield* input.gitHubCli.listPullRequests({
          cwd: input.cwd,
          repository,
          headSelector,
          state: "all",
          limit: 20,
        });
        for (const pullRequest of pullRequests) {
          const discovered = toDiscoveredPullRequest(repository, priority, pullRequest);
          if (!matchesBranchHeadContext(discovered, headContext)) {
            continue;
          }
          const key = normalizePullRequestKey(discovered.repository, discovered.number);
          const existing = found.get(key);
          if (!existing) {
            found.set(key, discovered);
            continue;
          }
          const existingUpdatedAt = existing.updatedAt ? Date.parse(existing.updatedAt) : 0;
          const discoveredUpdatedAt = discovered.updatedAt ? Date.parse(discovered.updatedAt) : 0;
          if (discoveredUpdatedAt > existingUpdatedAt) {
            found.set(key, discovered);
          }
        }
      }
    }

    return Array.from(found.values())
      .toSorted((left, right) => {
        if (left.repositoryPriority !== right.repositoryPriority) {
          return left.repositoryPriority - right.repositoryPriority;
        }
        const leftStateWeight = stateSortWeight(left.state);
        const rightStateWeight = stateSortWeight(right.state);
        if (leftStateWeight !== rightStateWeight) {
          return leftStateWeight - rightStateWeight;
        }
        const leftUpdatedAt = left.updatedAt ? Date.parse(left.updatedAt) : 0;
        const rightUpdatedAt = right.updatedAt ? Date.parse(right.updatedAt) : 0;
        return rightUpdatedAt - leftUpdatedAt;
      })
      .slice(
        0,
        Math.min(input.limit ?? MAX_DISCOVERED_PULL_REQUESTS, MAX_DISCOVERED_PULL_REQUESTS),
      );
  });
}

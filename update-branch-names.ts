import { prompt } from "inquirer";
import { Octokit } from "@octokit/rest";
import parseLinkHeader from "parse-link-header";
import sortBy from "lodash/sortBy";
import chunk from "lodash/chunk";

interface GitHubRepository {
  id: number;
  default_branch: string;
  fork: boolean;
  name: string;
  full_name: string;
  owner: {
    login: string;
    // ...
  };
  // ...
}

function getGitHubPersonalAccessToken(): string {
  if (!process.env.GH_TOKEN) {
    console.error(
      'The environment variable GH_TOKEN needs to contain a personal access token to access your private repositories.\n\nGo to https://github.com/settings/tokens to generate one with the "repo" scope.'
    );
    throw new Error(
      "The environment variable GH_TOKEN needs to contain a personal access token"
    );
  }
  return process.env.GH_TOKEN;
}

async function changeDefaultBranch(
  octokit: Octokit,
  repository: GitHubRepository,
  toBranch: string
): Promise<void> {
  try {
    // Retrieve the SHA value for the current default branch ref
    const ref = await octokit.git.getRef({
      owner: repository.owner.login,
      repo: repository.name,
      ref: `heads/${repository.default_branch}`,
    });

    // Create new branch
    await octokit.git.createRef({
      owner: repository.owner.login,
      repo: repository.name,
      ref: `refs/heads/${toBranch}`,
      sha: ref.data.object.sha,
    });

    // Change default branch
    await octokit.repos.update({
      owner: repository.owner.login,
      repo: repository.name,
      default_branch: toBranch,
    });

    // Delete old branch
    await octokit.git.deleteRef({
      owner: repository.owner.login,
      repo: repository.name,
      ref: `heads/${repository.default_branch}`,
    });
  } catch (error) {
    console.error("Error updating %s", repository.full_name);
    throw error;
  }
}

async function main(): Promise<void> {
  const { fromBranch, toBranch } = await prompt([
    {
      name: "fromBranch",
      message: "Enter the branch name you want to move away from",
    },
    {
      name: "toBranch",
      message: "Enter the branch name you want to change to",
    },
  ]);

  const octokit = new Octokit({
    auth: getGitHubPersonalAccessToken(),
  });

  // Retrieve repositories
  const allRepositories: GitHubRepository[] = [];
  let currentPage = 0;
  let lastPage = 1;
  do {
    currentPage++;
    console.log(
      `Retrieving GitHub repositories${
        currentPage > 1 ? ` (${currentPage}/${lastPage})` : ""
      }`
    );
    const response = await octokit.repos.listForAuthenticatedUser({
      page: currentPage,
      per_page: 100,
    });

    const linkHeader = parseLinkHeader(response.headers.link);
    if (linkHeader.last) {
      lastPage = parseInt(linkHeader.last.page, 10);
    }

    allRepositories.push(...response.data);
  } while (currentPage < lastPage);

  const repositories = allRepositories.filter(
    ({ default_branch, fork }) =>
      // Only keep repositories that match the "from" branch name
      default_branch === fromBranch &&
      // Filter out forks
      !fork
  );
  if (!repositories.length) {
    console.log(
      "No repositories found with the default branch %s. Exiting",
      fromBranch
    );
    return;
  }

  console.log(
    "Found %d repositories with the default branch %s",
    repositories.length,
    fromBranch
  );

  // Sort repositories alphabetically by full_name
  const sortedRepositories = sortBy(repositories, "full_name");
  const { repositoryIdsToUpdate } = await prompt([
    {
      name: "repositoryIdsToUpdate",
      message: "Please choose the repositories that should be updated",
      choices: sortedRepositories.map(({ id, full_name }) => ({
        name: full_name,
        value: id,
      })),
      type: "checkbox",
    },
  ]);

  const batches = chunk(repositoryIdsToUpdate, 10);
  for (const [index, batch] of batches.entries()) {
    console.log("Updating repositories (%d/%d)", index + 1, batches.length);
    await Promise.all(
      batch
        .map((repoId: number) => repositories.find(({ id }) => id === repoId))
        .map((repository: GitHubRepository) =>
          changeDefaultBranch(octokit, repository, toBranch)
        )
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

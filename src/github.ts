// Check runs and the upserted PR comment, through the workflow's token.
import * as github from '@actions/github';

export type Octokit = ReturnType<typeof github.getOctokit>;

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'failure' | 'warning' | 'notice';
  message: string;
  title?: string;
}

export interface Repo {
  owner: string;
  repo: string;
}

/** GitHub accepts at most 50 annotations per request. */
const ANNOTATION_BATCH = 50;

/** Creates a completed check run, sending annotations in batches of 50. */
export async function createCheckRun(
  octokit: Octokit,
  repo: Repo,
  run: { name: string; headSha: string; conclusion: 'success' | 'failure' | 'neutral'; title: string; summary: string; text?: string; annotations: Annotation[] },
): Promise<number> {
  const batches: Annotation[][] = [];
  for (let i = 0; i < run.annotations.length; i += ANNOTATION_BATCH) batches.push(run.annotations.slice(i, i + ANNOTATION_BATCH));
  const output = (annotations: Annotation[]) => ({ title: run.title, summary: run.summary, text: run.text, annotations });
  const { data } = await octokit.rest.checks.create({
    ...repo,
    name: run.name,
    head_sha: run.headSha,
    status: batches.length > 1 ? 'in_progress' : 'completed',
    ...(batches.length > 1 ? {} : { conclusion: run.conclusion }),
    output: output(batches[0] ?? []),
  });
  for (const [n, batch] of batches.slice(1).entries()) {
    const last = n === batches.length - 2;
    await octokit.rest.checks.update({
      ...repo,
      check_run_id: data.id,
      output: output(batch),
      ...(last ? { status: 'completed', conclusion: run.conclusion } : {}),
    });
  }
  return data.id;
}

/** Edits the comment carrying `marker`, or adds one. Returns its URL. */
export async function upsertComment(octokit: Octokit, repo: Repo, issueNumber: number, marker: string, body: string): Promise<string> {
  const text = `${marker}\n${body}`;
  const comments = await octokit.paginate(octokit.rest.issues.listComments, { ...repo, issue_number: issueNumber, per_page: 100 });
  const mine = comments.find((c) => c.body?.includes(marker));
  if (mine) {
    const { data } = await octokit.rest.issues.updateComment({ ...repo, comment_id: mine.id, body: text });
    return data.html_url;
  }
  const { data } = await octokit.rest.issues.createComment({ ...repo, issue_number: issueNumber, body: text });
  return data.html_url;
}

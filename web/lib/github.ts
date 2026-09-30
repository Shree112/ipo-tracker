// Start a GitHub Actions workflow (workflow_dispatch). Used by the schedule
// (/api/cron/...) and right after an approval (the "You're in" email).
// Needs GITHUB_DISPATCH_TOKEN on Vercel: a fine-grained token for this
// repository with "Actions: Read and write".

export const WORKFLOWS: Record<string, { file: string; inputs?: Record<string, string> }> = {
  refresh: { file: "refresh.yml", inputs: { mode: "hourly" } },
  live: { file: "live.yml" },
  chatter: { file: "chatter.yml" },
  accounts: { file: "accounts.yml" },
};

export async function startWorkflow(job: string): Promise<{ ok: boolean; error?: string; detail?: string; status: number }> {
  const wf = WORKFLOWS[job];
  if (!wf) return { ok: false, error: "unknown workflow", status: 404 };
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO || "Shree112/ipo-tracker";
  if (!token) return { ok: false, error: "GITHUB_DISPATCH_TOKEN is not set on Vercel", status: 501 };
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${wf.file}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main", ...(wf.inputs ? { inputs: wf.inputs } : {}) }),
    signal: AbortSignal.timeout(15000),
  }).catch((e: unknown) => ({ status: 0, text: async () => String(e) }) as unknown as Response);
  if (r.status !== 204) {
    return { ok: false, error: `GitHub answered ${r.status}`, detail: (await r.text()).slice(0, 300), status: 502 };
  }
  return { ok: true, status: 200 };
}

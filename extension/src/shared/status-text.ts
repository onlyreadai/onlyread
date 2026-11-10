// Plain-language status for the settings page and the popup, from the background's Status. Pure, so the
// wording for every state is tested in one place.
import type { Status } from './types';
import { cloudProblem } from './cloud-ui';

type StatusLike = Pick<Status, 'enabled' | 'mode' | 'attachmentActive' | 'attachedTabs' | 'judge' | 'judgeProblem' | 'judgeConsent' | 'cloud'>
  & Partial<Pick<Status, 'storageProblem' | 'startupProblem' | 'verdictsProblem' | 'policyProblem' | 'policyRepaired' | 'managedPending'>>;

/** What went wrong in the background, if anything, as one sentence for the settings page (under the guard
 *  line) and the popup; empty when nothing did. Startup first: the guard may be incomplete. */
export function problemLine(st: StatusLike): string {
  if (st.startupProblem) return `Startup did not finish (${st.startupProblem}). Reload the extension.`;
  // A change from the Pro account's site list waiting for the settings lock (background/cloud-sync.ts).
  if (st.managedPending) return `${st.managedPending}.`;
  if (st.policyProblem) return `${st.policyProblem}.`;
  if (st.verdictsProblem) return `The sites' tested verdicts were not restored (${st.verdictsProblem}); their reads are judged until the next successful start.`;
  if (st.storageProblem) return `Storage problem: ${st.storageProblem}.`;
  return '';
}

/** The popup's footer line, and whether it is a warning. A Pro problem outranks everything else. */
export function popupFooter(st: StatusLike): { text: string; warn: boolean } {
  const issue = cloudProblem(st.cloud);
  if (issue) return { text: issue.text, warn: true };
  if (st.startupProblem) return { text: 'Startup did not finish. Reload the extension', warn: true };
  if (!st.enabled) return { text: 'Protection is off', warn: true };
  if (st.managedPending) return { text: st.managedPending, warn: true };
  if (st.policyProblem) return { text: st.policyRepaired ? `A stored setting was reset (${st.policyRepaired}). Check the settings` : 'Stored settings were invalid. Defaults in use', warn: true };
  if (st.verdictsProblem) return { text: 'Tested verdicts not restored. Reads are judged', warn: true };
  if (st.storageProblem) return { text: 'Storage problem. The activity log may be behind', warn: true };
  if (!st.attachmentActive) return { text: 'Standing by for an AI agent', warn: false };
  if (st.mode === 'monitor') return { text: 'Monitor mode: nothing is refused', warn: true };
  if (st.attachedTabs === 0) return { text: 'Protecting, no guarded site open', warn: false };
  return { text: 'Protecting, writes are refused', warn: false };
}

/** Under the switch of a site only the Pro account guards: switching it off there removes it from the account, for every
 *  browser signed in to it, and this line says so. */
export const ACCOUNT_ONLY_SWITCH = 'Managed on your Pro account page';

/** Under the switch of a site the Pro account guards by guarding every site without allowing it: fixed here. */
export const GUARD_ALL_ACCOUNT_SWITCH = 'Every site is guarded by your Pro account';

/** A site row's one line: the first sentence of its description, or the judge-only note. The note says what the site
 *  is, not what is happening to it: the row may be switched off, or the browser in monitor mode or with protection
 *  off, where nothing is refused. OnlyRead Pro's lib/managed.ts siteSummary says the same. */
const JUDGE_ONLY_SUMMARY = 'Requests are checked by the AI judge.';
export function siteSummary(description: string | undefined): string {
  if (!description) return JUDGE_ONLY_SUMMARY;
  return description.split(/(?<=\.)\s/)[0] ?? description;
}

/** Significant exclusions (the profile's outOfScope), shown outside the collapsed details: "Messenger is not guarded." */
export function exclusionLine(outOfScope: string[] | undefined): string {
  return (outOfScope ?? []).map((x) => `${(x.split(':')[0] ?? x).replace(/\s*\(.*\)/, '').trim()} is not guarded.`).join(' ');
}

// ---- The settings page's status card (Overview): a heading, three facts with colour only on
// the one that needs attention, and at most one action, the most important problem with one button.

type OverviewStatus = StatusLike & Pick<Status, 'attachWhen' | 'agentSession'> & Partial<Pick<Status, 'byokLabel' | 'lock' | 'agentWhere'>>;

interface Fact { label: string; value: string; warn: boolean }

export function overviewHeading(st: OverviewStatus): string {
  if (!st.enabled) return 'Protection is off';
  if (st.mode === 'monitor') return 'Monitor mode: nothing is refused';
  return 'Your agents are read-only';
}

function protectionFact(st: OverviewStatus): Fact {
  if (!st.enabled) return { label: 'Protection', value: 'Off', warn: true };
  if (st.mode === 'monitor') return { label: 'Protection', value: 'Monitor mode', warn: true };
  return { label: 'Protection', value: st.attachWhen === 'always' ? 'On, always' : 'On, during agent sessions', warn: false };
}

const PRO_STATE: Record<string, string> = { subscribe: 'Pro, subscription inactive', wait: 'Pro, usage used up', retry: 'Pro, unreachable' };

function judgeFact(st: OverviewStatus): Fact {
  const c = st.cloud;
  if (c?.provider === 'cloud') {
    const issue = cloudProblem(c);
    if (!issue) return { label: 'AI judge', value: 'Pro', warn: false };
    const value = issue.action !== 'signin' ? PRO_STATE[issue.action]! : c.signedIn || c.signedOutAt ? 'Pro, signed out' : 'Pro, not signed in';
    return { label: 'AI judge', value, warn: true };
  }
  if (st.judge === 'rules-only') return { label: 'AI judge', value: 'Not set up', warn: true };
  return { label: 'AI judge', value: st.byokLabel ? `Your ${st.byokLabel} key` : 'Your own key', warn: false };
}

/** Protection, Agent, AI judge. */
export function overviewFacts(st: OverviewStatus): Fact[] {
  return [protectionFact(st), { label: 'Agent', value: !st.agentSession ? 'None working now' : st.agentWhere ? `Working now, on ${st.agentWhere}` : 'Working now', warn: false }, judgeFact(st)];
}

export type OverviewButton = 'enable' | 'signin' | 'subscribe' | 'manage' | 'retry' | 'set-key' | 'unlock' | 'enforce' | 'reload';
interface OverviewAction { text: string; button?: { label: string; action: OverviewButton } }

const PRO_BUTTON: Record<string, OverviewAction['button']> = {
  signin: { label: 'Sign in again', action: 'signin' },
  subscribe: { label: 'Get Pro', action: 'subscribe' },
  wait: { label: 'Manage subscription', action: 'manage' },
  retry: { label: 'Try again', action: 'retry' },
};

/** The judge's problem as an action, or undefined. */
function judgeAction(st: OverviewStatus): OverviewAction | undefined {
  if (st.judgeConsent === false) return { text: 'The AI judge is off until you agree to what it is sent, so requests no rule covers are refused.', button: { label: 'Review', action: 'set-key' } };
  const issue = cloudProblem(st.cloud);
  if (issue) {
    const button = issue.action === 'signin' && !st.cloud?.signedOutAt ? { label: 'Sign in', action: 'signin' as const } : PRO_BUTTON[issue.action];
    return { text: `${issue.text}.`, button };
  }
  if (st.judge === 'rules-only' && st.cloud?.provider !== 'cloud') {
    return { text: `The AI judge needs ${st.judgeProblem?.replace(/^add your /, 'your ') ?? 'setting up'}, so requests no rule covers are refused.`, button: { label: 'Set up a key', action: 'set-key' } };
  }
  return undefined;
}

/** The one problem worth a row, most important first; undefined when all is well. */
export function overviewAction(st: OverviewStatus): OverviewAction | undefined {
  if (st.startupProblem) return { text: `Startup did not finish (${st.startupProblem}).`, button: { label: 'Reload OnlyRead', action: 'reload' } };
  if (!st.enabled) return { text: 'Nothing is guarded while protection is off.', button: { label: 'Turn on', action: 'enable' } };
  const judge = judgeAction(st);
  if (judge) return judge;
  if (st.managedPending) {
    const unlock = st.lock?.pinSet && !st.lock.agent ? { label: 'Unlock', action: 'unlock' as const } : undefined;
    return { text: `${st.managedPending}.`, button: unlock };
  }
  if (st.mode === 'monitor') return { text: 'Monitor mode logs requests and refuses nothing.', button: { label: 'Refuse writes', action: 'enforce' } };
  const problem = problemLine(st);
  return problem ? { text: problem } : undefined;
}

/** What an AI agent set up from the Pro setup page (background/agent-setup.ts), for the line beside its Undo; shown
 *  for a day, apart from the one action, so a judge that still needs a key does not hide it. */
export function setupLine(setup: Status['agentSetup']): string | undefined {
  return setup ? `An AI agent set up OnlyRead: ${setup.summary}.` : undefined;
}

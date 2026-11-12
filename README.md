# pi-tree-state

A [pi](https://github.com/earendil-works/pi) extension that keeps a snapshot of the code for each point of the session tree, and brings it back when `/tree` moves there.

It needs only a git repository, and works with any model.

## Install

```bash
pi install npm:pi-tree-state
```

To try it for one session without installing:

```bash
pi -e npm:pi-tree-state
```

Or install it from GitHub, pinned to a release tag:

```bash
pi install git:github.com/na0x2c6/pi-tree-state@v0.1.0
```

## Code

A snapshot is taken when a user message arrives and after every turn, unless the code is what the path already leads to. It has the shape of `git stash push -u`: a commit of the worktree whose parents are HEAD, a commit of the index and, when there are any, a commit of the untracked files. The stash list and the index stay untouched.

Each session has one ref, `refs/pi/sessions/<session id>`. Its reflog is the list of snapshots, each named by its entry:

```bash
git log -g --format='%h %gs %ci' refs/pi/sessions/<session id>
git stash apply --index <commit>      # restores one by hand
```

The snapshots do not descend from each other, so git expires them as unreachable reflog entries: after 30 days by default, at the next `git gc`. To keep them longer, or forever:

```bash
git config --global 'gc.refs/pi/*.reflogExpireUnreachable' never
git config --global 'gc.refs/pi/*.reflogExpire' never
```

Ignored files are not snapshotted, nor are untracked files over 16 MiB. No snapshot is taken before the first commit or while the index has unmerged paths.

### Several repositories

A session is not limited to the repository it started in. Each repository it touches keeps its own ref and reflog, with the same entry ids, so one point of the conversation stands for one state of all of them, and a turn that edits several is restored together.

| How a repository joins | When it is recorded |
|---|---|
| The one the session started in | At the first prompt |
| `edit` or `write` on a file in it, anywhere on disk, found with `git -C <its directory>` | Before the tool runs |
| Nested in a known repository, or its submodule | At the next snapshot, so at the first prompt if it was already there |

A repository that joins later keeps its first state as `entry=root`, which covers every earlier point. A nested repository created during the session, or one outside the known ones that only `bash` touches, is not seen before the change; bash commands do not say what they change. Submodules are restored like any repository: their files, not their commit in the parent.

The list of repositories is `<agent dir>/tree-state/<session id>/repos.json`; `/tree-state` prints it.

## /tree

pi's "Summarize branch?" menu is fixed, so a second dialog follows it when the code of the target differs from the current code:

The choice applies to every repository that differs, and the title says how many.

| Choice | Worktree | Index |
|---|---|---|
| Keep current code | kept | kept |
| Restore worktree | restored | kept |
| Restore worktree and index | restored | restored |
| Cancel navigation | kept | kept |

A restore makes the worktree match exactly, removing files added since. HEAD does not move. It happens only once the navigation is done, so cancelling a summary leaves the files alone. If one repository fails, the others are still restored and the failure is shown. `/code-undo` goes back to the code before the last restore, in all of its repositories.

`/fork` asks the same.

## /code-restore

Brings back the code of a point while the conversation stays where it is, the same as going there with a restore and coming back with "Keep current code". It lists each user message, for the code it was sent with, and the end of each branch, for the code the branch was left with, newest first. `*` marks the current branch.

```text
/code-restore              # choose from the list
/code-restore 3f9a2c1e     # the entry with this id, or a prefix of it
```

It asks for the worktree or the worktree and index, as `/tree` does, and `/code-undo` goes back. The restored code is recorded at the next message, under that message, so the point it came from keeps its own snapshot.

When "Summarize" was chosen too, the summary ends by saying whether the changes of that branch are still in the files, which the summary could not know otherwise. An extension that writes the summary itself gets that sentence from `tree-state:code-note` on `pi.events`.

Load such an extension after this one. pi runs them in that order and keeps the last result: the other way round the dialog comes after the summary, the sentence is missing from it, and what this extension returns for pi's summary replaces it.

## Development

```bash
npm install
npm run check
npm test
```

The e2e runs drive a real session against an OpenAI-compatible server, such as llama.cpp's `llama-server`, at `http://127.0.0.1:8081` unless `LLAMA_URL` says otherwise. `E2E_TOOLS=1` gives the model its tools, and `E2E_EXTENSIONS` loads more extensions, separated by `:`.

```bash
node test/e2e/run.ts [model]
LLAMA_URL=http://127.0.0.1:8080 node test/e2e/run.ts [model]
E2E_TOOLS=1 node test/e2e/repos.ts [model]
E2E_EXTENSIONS=../summary.ts node test/e2e/run.ts [model]
```

## License

Apache-2.0

// Every word the person reads, in English and Vietnamese. Pure data and functions: no engine calls, so it is unit-tested
// without an engine. `vi` is typed as `Strings` (the shape of `en`), so a key missing from either table fails tsc.
// Not in here, on purpose: what Claude reads (the deny reason, the note after an allowed call). Those stay English in
// describe.ts because Claude, not the person, reads them.
//
// Functions here take plain values and put them into a sentence: they do not clean text. A path, a branch name or a
// command word goes through describe.ts (shortPath, sanitizeShown) first, and a name arrives already in ASCII double quotes
// ("build/"), so that a hostile file name cannot read as a part of the sentence.

export type Lang = 'en' | 'vi'

/** A count as a whole number that is safe to print: never NaN, negative, fractional or in exponent form. */
const whole = (n: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(0, Math.floor(n)), Number.MAX_SAFE_INTEGER) : 0

/** `1234567` as `1,234,567` (or with another separator). */
const group = (n: number, sep: string): string => String(whole(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep)

/** English: `1 file`, `0 files`, `12 files`. */
const plural = (n: number, one: string, many: string) => `${group(n, ',')} ${whole(n) === 1 ? one : many}`

/** Vietnamese does not inflect: `12 file`, with a dot between thousands. */
const viCount = (n: number, word: string) => `${group(n, '.')} ${word}`

const en = {
  // the band
  pill: 'WAITING FOR YOU',
  buttons: { allow: 'Allow', cancel: 'Cancel', details: 'See changes', hideDetails: 'Hide changes' },
  moreWaiting: (n: number) => `${group(n, ',')} more waiting`,
  byAgent: 'A subagent asked for this.',
  allowIt: 'Allow it?',

  // what is about to happen: one sentence per kind of risk; paths, names and the remote arrive already cleaned (names quoted)
  title: {
    unknown: 'About to make a change that is hard to undo',
    deleteFolder: (path: string) => `About to delete the folder ${path}`,
    deleteFile: (path: string) => `About to delete the file ${path}`,
    deleteItems: (n: number, list: string) => `About to delete ${group(n, ',')} items: ${list}`,
    deleteEverything: 'About to delete everything in this project',
    deletePicked: 'About to delete files that this command picks when it runs',
    // `find ... -name <pattern> -delete`: the name the filter looks for (quoted) and where it looks (quoted)
    deleteNamedHere: (name: string) => `About to delete everything named ${name} in this project`,
    deleteNamedUnder: (name: string, path: string) => `About to delete everything named ${name} under ${path}`,
    overwriteFile: (path: string) => `About to overwrite the file ${path}`,
    overwriteItems: (n: number, list: string) => `About to overwrite ${group(n, ',')} files: ${list}`,
    overwriteEverything: 'About to overwrite everything in this project',
    overwritePicked: 'About to overwrite files that this command picks when it runs',
    listMore: (n: number) => ` and ${group(n, ',')} more`,
    // `branch` and `remote` are '' when the command does not name them
    forcePush: (branch: string, remote: string) =>
      `About to overwrite the history ${branch ? `of branch ${branch} ` : ''}on ${remote || 'the remote'}`,
    resetHard: 'About to throw away all changes you have not committed',
    clean: 'About to delete the files Git does not track',
    discard: 'About to discard all changes you have not committed',
    unparsed: 'This command line is too long or too tangled for Safety Net to read to the end',
    // emptying Git's own safety nets; the words follow the label of the risk (hooks/risk.ts), any other one reads as `gitErase`
    gitStashDrop: 'About to delete a saved stash from Git',
    gitStashClear: 'About to delete every saved stash from Git',
    gitRefDelete: 'About to delete a Git reference',
    gitHistoryErase: "About to permanently erase Git's safety history",
    gitErase: "About to erase part of Git's own safety nets",
    branchDelete: (name: string) =>
      name ? `About to delete the branch ${name}, even if it is not merged` : 'About to delete a branch, even if it is not merged',
    dbDrop: (name: string) => (name ? `About to drop the database/table ${name}` : 'About to erase data in a database'),
    plusMore: (n: number) => ` (+${group(n, ',')} more)`,
  },
  // the second sentence: what makes it hard to undo
  note: {
    forcePush: 'Commits your teammates pushed that you do not have will be lost. Hard to undo.',
    uncommitted: 'Changes you have not committed cannot be brought back by Git.',
    branchDelete: 'Commits only on that branch will be hard to find.',
    dbDrop: 'Data in a database is not part of the snapshot.',
    unparsed: 'Something dangerous could be hiding in the part it did not read: read the command before you allow it.',
    gitErase: 'Git cannot bring this back.',
    // the command line holds more commands than the ones that were flagged
    others: (n: number) =>
      `+${plural(n, 'other command', 'other commands')} in this line that Safety Net did not flag; read the command before you allow it.`,
  },
  // the first words of a command that could not be read to the end (shown in quotes, dim)
  snippet: (text: string) => `The command starts: "${text}"`,

  // the snapshot line under the title; `at` and `n` are '' when unknown
  snapshot: {
    saved: (at: string, n: string) => `Snapshot saved${at ? ` at ${at}` : ''}${n ? ` (#${n})` : ''}`,
    size: (files: number, bytes: string) => `${plural(files, 'file', 'files')}, ${bytes}`,
    partial: 'some files were left out',
    gitOnly: 'Git state saved (no files to copy)',
    nothing: 'No snapshot: there is nothing in this project to copy',
    // a Git snapshot was asked for but the uncommitted changes could not be saved; follows the line above after a comma
    gitPartial: 'but Git could not save your uncommitted changes (an unfinished merge, for example)',
    gitPartialNoFiles: 'No files to copy, and Git could not save your uncommitted changes (an unfinished merge, for example)',
    nothingToSave: 'Nothing to save for this one',
    // the call deletes the project's `.git` folder too, which is never copied; added after the line above
    gitLost: 'The Git history (.git) goes too and is not saved: commits you have not pushed, local branches and stashes cannot come back',
    tooBig: (limitMB: number) => `No snapshot: more than ${group(limitMB, ',')} MB would be touched, which is over the limit`,
    tooMany: (files: number) => `No snapshot: more than ${group(files, ',')} files would be touched, which is over the limit`,
    failed: 'No snapshot could be saved, so /safety restore cannot bring this back',
    // only a .env-like file was to be saved and there is no Node.js to keep its copy private
    needsNode: 'Not saved: a .env file is copied only when Node.js is installed, so its copy can be kept private',
  },

  // overwriting a .env-like file: names only, never values
  env: {
    head: (before: number, after: number) => `The old file has ${plural(before, 'variable', 'variables')}, the new one ${group(after, ',')}`,
    loses: (list: string) => `it loses ${list}`,
    adds: (list: string) => `it adds ${list}`,
    both: (lost: string, added: string) => `it loses ${lost}; it adds ${added}`,
    same: 'the same variable names',
    more: (n: number) => ` and ${group(n, ',')} more`,
  },

  // masked secrets, toasts
  masked: (n: number) =>
    whole(n) === 1
      ? '◈ 1 secret value was masked before it entered the conversation.'
      : `◈ ${group(n, ',')} secret values were masked before they entered the conversation.`,
  toast: {
    saved: (n: string) => `Snapshot #${n} saved before this command. Undo: /safety restore ${n}`,
    savedNoNumber: 'Snapshot saved before this command. Undo: /safety restore',
    savedGitPartial: (n: string) => `Snapshot #${n} saved before this command, but Git could not save your uncommitted changes`,
    gitSaved: 'Git state saved before this command. Undo: /safety restore',
    tooBig: (limitMB: number) => `No snapshot before this command: it is over the ${group(limitMB, ',')} MB limit`,
    tooMany: (files: number) => `No snapshot before this command: it touches more than ${group(files, ',')} files`,
    failed: 'No snapshot could be saved before this command',
    needsNode: 'No snapshot before this command: a .env file is copied only when Node.js is installed',
  },

  // days
  day: {
    today: 'today',
    yesterday: 'yesterday',
    dateShort: (month: number, day: number) =>
      `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][whole(month) - 1] ?? ''} ${whole(day)}`.trim(),
  },

  // /safety
  usage: 'Usage: /safety list | /safety restore [number] | /safety undo | /safety doctor',
  usageRestore: 'Usage: /safety restore [number] (the number from /safety list; with no number the newest snapshot is restored)',
  commandDescription: 'Safety Net: see snapshots (list), put one back (restore [number]), undo the last restore (undo), check the setup (doctor)',
  commandHint: '[list | restore [number] | undo | doctor]',
  thisProject: 'this project',
  noSnapshots: 'There are no snapshots for this project yet.',
  noSuchSnapshot: (arg: string) => `There is no snapshot #${arg}. /safety list shows them.`,
  noUndo: 'There is nothing to undo: no restore has been done in this project yet.',
  damaged: (n: string) => `Snapshot #${n} cannot be read (its record is damaged), so it cannot be restored.`,
  projectUnknown: 'Safety Net could not tell which project this is, so it has no snapshots to show.',
  busy: 'Another restore is running right now. Try again in a moment.',
  failed: (why: string) => `Safety Net could not do that: ${why}`,

  list: {
    header: (project: string, n: number) => `Snapshots for ${project} (${group(n, ',')}):`,
    more: (n: number) => `... and ${group(n, ',')} more`,
    undoPoint: '(undo point)',
    quiet: '(saved quietly)',
    gitOnly: 'Git copy only',
    // a Git snapshot with no files, where Git could not save the uncommitted changes
    gitPartial: 'Git could not save your changes',
    noFiles: 'no files',
    hint: 'Put one back with /safety restore <number>, or /safety restore for the newest.',
  },

  // the result of /safety restore; `n` and `at` are '' when unknown
  restore: {
    done: (count: number, at: string) => `Restored ${plural(count, 'file', 'files')}${at ? ` to ${at}` : ''}`,
    partial: (count: number, at: string) => `Partly restored: ${plural(count, 'file', 'files')}${at ? ` to ${at}` : ''}`,
    ref: (n: string) => `(snapshot #${n})`,
    nothing: (n: string) =>
      `Nothing needed restoring${n ? ` from snapshot #${n}` : ''}: it has no files to put back, or they are already as they were.`,
    failedAll: (n: string) => `Could not restore ${n ? `snapshot #${n}` : 'the snapshot'}. Nothing was changed.`,
    failedFiles: (count: number) => `Could not restore ${plural(count, 'file', 'files')}:`,
    kept: (count: number, at: string) => `Kept ${plural(count, 'file', 'files')} created after ${at || 'the snapshot'}.`,
    more: (n: number) => `… and ${group(n, ',')} more`,
    undoHint: 'Changed your mind? /safety undo',
    noUndo: 'An undo point could not be saved this time, so /safety undo is not available.',
    // the undo point could not be saved: files that already exist were not overwritten, only the missing ones were put back
    leftAsIs: (count: number) =>
      `Not overwritten: ${plural(count, 'file', 'files')} already there. Safety Net could not save their current versions first, so nothing that exists was overwritten. Free some disk space or move them away, then run /safety restore again.`,
    // every place the restore wrote to was empty: nothing was overwritten, so there was nothing to save
    noneOverwritten: 'Nothing was overwritten, so there is no undo point: /safety undo cannot take restored files away again. To remove them, delete them yourself.',
    gitIntro: 'Git: the commits and changes were saved too. To bring them back yourself, run:',
    // a force push: only the remote branch as it was last fetched is kept, never uncommitted changes
    gitIntroRemote: 'Git: the last-fetched copy of the remote branch is saved as a branch name you can restore. To bring it back yourself, run:',
    // saved branch tips whose names cannot be shown: one command lists them
    otherTips: 'Other saved branch tips (their names cannot be shown here). To list them, run:',
    // Git could not save the uncommitted changes when the snapshot was taken: nothing about them is promised
    gitPartial:
      'Git could not save your uncommitted changes when this snapshot was taken (an unfinished merge, for example), so there is nothing to bring back from Git.',
    gitPartialSome:
      'Git could not save your uncommitted changes when this snapshot was taken (an unfinished merge, for example), so those cannot be brought back from Git. To bring back what Git did save, run:',
  },
  // the result of /safety undo
  undo: {
    done: (count: number, at: string) =>
      `Undid the last restore: ${plural(count, 'file', 'files')} back as they were${at ? ` at ${at}` : ''}`,
    partial: (count: number, at: string) =>
      `Partly undone: ${plural(count, 'file', 'files')} back as they were${at ? ` at ${at}` : ''}`,
    nothing: (n: string) => `Nothing needed undoing${n ? ` from snapshot #${n}` : ''}: the files are already as they were.`,
    failedAll: 'Could not undo the last restore. Nothing was changed.',
    again: 'To go back again: /safety undo',
    noAgain: 'Going back again is not available this time, because no undo point could be saved.',
    leftAsIs: (count: number) =>
      `Not overwritten: ${plural(count, 'file', 'files')} already there. Safety Net could not save their current versions first, so nothing that exists was overwritten. Free some disk space or move them away, then run /safety undo again.`,
    noneOverwritten: 'Nothing was overwritten, so going back again is not needed: /safety undo cannot take restored files away again.',
  },

  // /safety doctor
  doctor: {
    summary: (pass: number, warn: number, fail: number) => `${whole(pass)} ok, ${whole(warn)} to look at, ${whole(fail)} broken.`,
    claudeOk: (v: string, min: string) => `Claude Code ${v} (needs ${min} or later)`,
    claudeOld: (v: string, min: string) =>
      `Claude Code ${v} is older than ${min}, so parts of Safety Net may not run. A newer Claude Code turns them on.`,
    claudeUnknown: (min: string) =>
      `Could not tell which Claude Code version this is (needs ${min} or later). Safety Net works as far as this version allows.`,
    nodeOk: (v: string) => `Node.js ${v} found: snapshots can include binary and large files`,
    nodeMissing: 'Node.js not found: snapshots then save text files up to 3 MB; with Node they also save binary and large files',
    gitOk: (v: string) => `Git ${v} found`,
    gitMissing: 'Git not found: Safety Net still saves files, but not the Git snapshot',
    folderOk: (dir: string, snapshots: string) => `Snapshot folder ${dir} can be written to: ${snapshots}`,
    folderFail: (dir: string) => `Cannot write to ${dir}: snapshots cannot be saved, but the questions and secret masking still work`,
    folderUnknown: (dir: string) => `Snapshot folder ${dir} could not be checked yet; it is made when the first snapshot is saved`,
    snapshotCount: (count: number, size: string) =>
      whole(count) === 0 ? 'no snapshots yet' : `${plural(count, 'snapshot', 'snapshots')}${size ? `, ${size}` : ''}`,
    // all snapshots of all projects against the total cap; `size` and `cap` arrive as sizes (`340 MB`, `2 GB`); `isCut` = the count stopped early
    totalNone: (cap: string) => `No snapshots in any project yet; all of them together may take up to ${cap}`,
    totalOk: (count: number, size: string, cap: string, isCut: boolean) =>
      `${isCut ? 'At least ' : ''}${plural(count, 'snapshot', 'snapshots')} in all projects, ${size} of the ${cap} they may take together`,
    totalOver: (count: number, size: string, cap: string, isCut: boolean) =>
      `${isCut ? 'At least ' : ''}${plural(count, 'snapshot', 'snapshots')} in all projects, ${size}: over the ${cap} they may take together, so the oldest are deleted when the next session starts`,
    helperOk: 'The Node helper script answered: binary and large files are saved too',
    helperNo: 'The Node helper script did not answer: snapshots save text files up to 3 MB; with the helper they also save binary and large files',
    helperUnknown: 'The Node helper script has not been tried yet: until it answers, snapshots save text files up to 3 MB',
    options: (confirm: string, mask: string, language: string) => `Options: ${confirm}; ${mask}; language: ${language}`,
    confirmRisky: 'asks before commands that delete, overwrite or rewrite history',
    confirmAlways: 'asks before risky commands and before overwriting any file Git does not track',
    confirmNever: 'never asks, but still saves a snapshot first',
    confirmUnknown: (value: string) => `"${value}" is not one of risky, always or never, so it asks before risky commands`,
    maskOn: 'masks secrets in tool results',
    maskOff: 'does not mask secrets (turned off)',
    languageNames: { en: 'English', vi: 'Tiếng Việt' } as Record<Lang, string>,
    surface: (s: string) => `Running in: ${s}`,
    surfaceUnknown: 'Where this session runs is not reported; nothing depends on it',
  },
}

export type Strings = typeof en

const vi: Strings = {
  pill: 'CHỜ XÁC NHẬN',
  buttons: { allow: 'Cho chạy', cancel: 'Huỷ', details: 'Xem khác biệt', hideDetails: 'Ẩn khác biệt' },
  moreWaiting: n => `còn ${group(n, '.')} mục nữa đang chờ`,
  byAgent: 'Một subagent của Claude đã yêu cầu việc này.',
  allowIt: 'Cho chạy không?',

  title: {
    unknown: 'Sắp thay đổi một thứ khó hoàn tác',
    deleteFolder: path => `Sắp xoá thư mục ${path}`,
    deleteFile: path => `Sắp xoá file ${path}`,
    deleteItems: (n, list) => `Sắp xoá ${group(n, '.')} mục: ${list}`,
    deleteEverything: 'Sắp xoá mọi thứ trong dự án này',
    deletePicked: 'Sắp xoá các file mà lệnh này tự chọn khi chạy',
    deleteNamedHere: name => `Sắp xoá mọi thứ có tên ${name} trong dự án này`,
    deleteNamedUnder: (name, path) => `Sắp xoá mọi thứ có tên ${name} trong ${path}`,
    overwriteFile: path => `Sắp ghi đè file ${path}`,
    overwriteItems: (n, list) => `Sắp ghi đè ${group(n, '.')} file: ${list}`,
    overwriteEverything: 'Sắp ghi đè mọi thứ trong dự án này',
    overwritePicked: 'Sắp ghi đè các file mà lệnh này tự chọn khi chạy',
    listMore: n => ` và ${group(n, '.')} mục nữa`,
    forcePush: (branch, remote) => `Sắp ghi đè lịch sử ${branch ? `nhánh ${branch} ` : ''}trên ${remote || 'remote'}`,
    resetHard: 'Sắp bỏ hết thay đổi bạn chưa commit',
    clean: 'Sắp xoá các file mà Git không theo dõi',
    discard: 'Sắp huỷ hết thay đổi bạn chưa commit',
    unparsed: 'Dòng lệnh này quá dài hoặc quá rối nên Safety Net không đọc hết được',
    gitStashDrop: 'Sắp xoá một stash đã lưu khỏi Git',
    gitStashClear: 'Sắp xoá mọi stash đã lưu khỏi Git',
    gitRefDelete: 'Sắp xoá một tham chiếu (ref) của Git',
    gitHistoryErase: 'Sắp xoá vĩnh viễn lịch sử dự phòng của Git',
    gitErase: 'Sắp xoá một phần các lớp bảo vệ có sẵn của Git',
    branchDelete: name => (name ? `Sắp xoá nhánh ${name}, kể cả khi chưa gộp` : 'Sắp xoá một nhánh, kể cả khi chưa gộp'),
    dbDrop: name => (name ? `Sắp xoá cơ sở dữ liệu/bảng ${name}` : 'Sắp xoá dữ liệu trong một cơ sở dữ liệu'),
    plusMore: n => ` (+${group(n, '.')} nữa)`,
  },
  note: {
    forcePush: 'Các commit mà đồng đội đã đẩy lên và bạn chưa có sẽ bị mất. Rất khó hoàn tác.',
    uncommitted: 'Git không thể khôi phục các thay đổi chưa commit.',
    branchDelete: 'Các commit chỉ có trên nhánh đó sẽ rất khó tìm lại.',
    dbDrop: 'Dữ liệu trong cơ sở dữ liệu không nằm trong snapshot.',
    unparsed: 'Có thể có thứ nguy hiểm nằm ở phần chưa đọc: hãy tự đọc lệnh trước khi cho chạy.',
    gitErase: 'Git không thể khôi phục việc này.',
    others: n => `+${viCount(n, 'lệnh khác')} trong dòng này mà Safety Net không đánh dấu; hãy đọc lệnh trước khi cho chạy.`,
  },
  snippet: text => `Lệnh bắt đầu bằng: "${text}"`,

  snapshot: {
    saved: (at, n) => `Đã chụp lại trạng thái${at ? ` lúc ${at}` : ''}${n ? ` (#${n})` : ''}`,
    size: (files, bytes) => `${viCount(files, 'file')}, ${bytes}`,
    partial: 'một số file bị bỏ qua',
    gitOnly: 'Đã lưu trạng thái Git (không có file nào cần chép)',
    nothing: 'Không có snapshot: trong dự án không có gì để chép',
    gitPartial: 'nhưng Git không lưu được các thay đổi chưa commit của bạn (ví dụ khi đang merge dở)',
    gitPartialNoFiles: 'Không có file nào để chép, và Git không lưu được các thay đổi chưa commit của bạn (ví dụ khi đang merge dở)',
    nothingToSave: 'Lần này không có gì để lưu',
    gitLost: 'Lịch sử Git (.git) cũng bị xoá và không được lưu: các commit chưa đẩy lên, nhánh trên máy và stash sẽ không khôi phục được',
    tooBig: limitMB => `Không có snapshot: vượt giới hạn ${group(limitMB, '.')} MB`,
    tooMany: files => `Không có snapshot: sẽ động đến hơn ${group(files, '.')} file, vượt giới hạn`,
    failed: 'Không lưu được snapshot nên /safety restore sẽ không khôi phục được việc này',
    needsNode: 'Chưa lưu: file .env chỉ được chép khi máy có Node.js, để bản chép được giữ riêng tư',
  },

  env: {
    head: (before, after) => `Bản cũ có ${group(before, '.')} biến, bản mới ${whole(after) < whole(before) ? 'chỉ ' : 'có '}${group(after, '.')}`,
    loses: list => `mất ${list}`,
    adds: list => `thêm ${list}`,
    both: (lost, added) => `mất ${lost}; thêm ${added}`,
    same: 'tên các biến vẫn như cũ',
    more: n => ` và ${group(n, '.')} biến nữa`,
  },

  masked: n => `◈ ${group(n, '.')} giá trị bí mật đã được che trước khi vào cuộc trò chuyện.`,
  toast: {
    saved: n => `Đã lưu snapshot #${n} trước lệnh này. Hoàn tác: /safety restore ${n}`,
    savedNoNumber: 'Đã lưu snapshot trước lệnh này. Hoàn tác: /safety restore',
    savedGitPartial: n => `Đã lưu snapshot #${n} trước lệnh này, nhưng Git không lưu được các thay đổi chưa commit của bạn`,
    gitSaved: 'Đã lưu trạng thái Git trước lệnh này. Hoàn tác: /safety restore',
    tooBig: limitMB => `Không có snapshot trước lệnh này: vượt giới hạn ${group(limitMB, '.')} MB`,
    tooMany: files => `Không có snapshot trước lệnh này: lệnh động đến hơn ${group(files, '.')} file`,
    failed: 'Không lưu được snapshot trước lệnh này',
    needsNode: 'Không có snapshot trước lệnh này: file .env chỉ được chép khi có Node.js',
  },

  day: {
    today: 'hôm nay',
    yesterday: 'hôm qua',
    dateShort: (month, day) => `${whole(day)}/${whole(month)}`,
  },

  usage: 'Cách dùng: /safety list | /safety restore [số] | /safety undo | /safety doctor',
  usageRestore: 'Cách dùng: /safety restore [số] (số trong /safety list; không có số thì khôi phục snapshot mới nhất)',
  commandDescription: 'Safety Net: xem các snapshot (list), khôi phục (restore [số]), hoàn tác lần khôi phục gần nhất (undo), kiểm tra cài đặt (doctor)',
  commandHint: '[list | restore [số] | undo | doctor]',
  thisProject: 'dự án này',
  noSnapshots: 'Dự án này chưa có snapshot nào.',
  noSuchSnapshot: arg => `Không có snapshot #${arg}. /safety list sẽ liệt kê các snapshot.`,
  noUndo: 'Chưa có gì để hoàn tác: dự án này chưa khôi phục lần nào.',
  damaged: n => `Không đọc được snapshot #${n} (bản ghi bị hỏng) nên không khôi phục được.`,
  projectUnknown: 'Safety Net không xác định được dự án này nên chưa có snapshot nào để hiện.',
  busy: 'Một lần khôi phục khác đang chạy. Hãy thử lại sau giây lát.',
  failed: why => `Safety Net chưa làm được việc đó: ${why}`,

  list: {
    header: (project, n) => `Snapshot của ${project} (${group(n, '.')}):`,
    more: n => `... và ${group(n, '.')} snapshot nữa`,
    undoPoint: '(điểm hoàn tác)',
    quiet: '(lưu ngầm)',
    gitOnly: 'chỉ có bản Git',
    gitPartial: 'Git không lưu được thay đổi của bạn',
    noFiles: 'không có file',
    hint: 'Khôi phục bằng /safety restore <số>, hoặc /safety restore để lấy bản mới nhất.',
  },

  restore: {
    done: (count, at) => `Đã khôi phục ${viCount(count, 'file')}${at ? ` về ${at}` : ''}`,
    partial: (count, at) => `Khôi phục một phần: ${viCount(count, 'file')}${at ? ` về ${at}` : ''}`,
    ref: n => `(snapshot #${n})`,
    nothing: n =>
      `Không có gì cần khôi phục${n ? ` từ snapshot #${n}` : ''}: snapshot không có file nào để đưa lại, hoặc các file đã đúng như cũ.`,
    failedAll: n => `Không khôi phục được ${n ? `snapshot #${n}` : 'snapshot'}. Chưa có gì bị thay đổi.`,
    failedFiles: count => `Không khôi phục được ${viCount(count, 'file')}:`,
    kept: (count, at) => `Giữ nguyên ${viCount(count, 'file')} mới tạo sau ${at || 'snapshot'}.`,
    more: n => `… và ${group(n, '.')} file nữa`,
    undoHint: 'Đổi ý? /safety undo',
    noUndo: 'Lần này chưa lưu được điểm hoàn tác nên /safety undo không dùng được.',
    leftAsIs: count =>
      `Đã để nguyên ${viCount(count, 'file')} đang có sẵn. Safety Net chưa lưu được bản hiện tại của chúng trước, nên không ghi đè gì cả. Hãy giải phóng bớt ổ đĩa hoặc dời các file đó đi rồi chạy lại /safety restore.`,
    noneOverwritten: 'Không file nào bị ghi đè nên không có điểm hoàn tác: /safety undo không xoá được các file vừa khôi phục. Muốn bỏ chúng, hãy tự xoá.',
    gitIntro: 'Git: các commit và thay đổi cũng đã được lưu. Muốn tự lấy lại, hãy chạy:',
    gitIntroRemote: 'Git: bản của nhánh remote ở lần fetch gần nhất đã được lưu thành một tên nhánh để bạn khôi phục. Muốn tự lấy lại, hãy chạy:',
    otherTips: 'Còn có các đầu nhánh khác đã được lưu (tên của chúng không hiện được ở đây). Muốn xem danh sách, hãy chạy:',
    gitPartial:
      'Git không lưu được các thay đổi chưa commit của bạn khi chụp snapshot này (ví dụ khi đang merge dở), nên không có gì để lấy lại từ Git.',
    gitPartialSome:
      'Git không lưu được các thay đổi chưa commit của bạn khi chụp snapshot này (ví dụ khi đang merge dở), nên không lấy lại các thay đổi đó từ Git được. Muốn lấy lại phần Git đã lưu, hãy chạy:',
  },
  undo: {
    done: (count, at) => `Đã hoàn tác lần khôi phục trước: ${viCount(count, 'file')} trở lại như ${at ? `lúc ${at}` : 'trước đó'}`,
    partial: (count, at) => `Hoàn tác một phần: ${viCount(count, 'file')} trở lại như ${at ? `lúc ${at}` : 'trước đó'}`,
    nothing: n => `Không có gì cần hoàn tác${n ? ` từ snapshot #${n}` : ''}: các file đã đúng như cũ.`,
    failedAll: 'Không hoàn tác được lần khôi phục trước. Chưa có gì bị thay đổi.',
    again: 'Muốn quay lại như vừa rồi: /safety undo',
    noAgain: 'Lần này không quay lại được nữa vì chưa lưu được điểm hoàn tác.',
    leftAsIs: count =>
      `Đã để nguyên ${viCount(count, 'file')} đang có sẵn. Safety Net chưa lưu được bản hiện tại của chúng trước, nên không ghi đè gì cả. Hãy giải phóng bớt ổ đĩa hoặc dời các file đó đi rồi chạy lại /safety undo.`,
    noneOverwritten: 'Không file nào bị ghi đè nên không cần quay lại: /safety undo không xoá được các file vừa khôi phục.',
  },

  doctor: {
    summary: (pass, warn, fail) => `${whole(pass)} ổn, ${whole(warn)} cần xem, ${whole(fail)} lỗi.`,
    claudeOk: (v, min) => `Claude Code ${v} (cần ${min} trở lên)`,
    claudeOld: (v, min) =>
      `Claude Code ${v} cũ hơn ${min} nên một số phần của Safety Net có thể không chạy. Claude Code mới hơn sẽ bật lại các phần đó.`,
    claudeUnknown: min =>
      `Không xác định được phiên bản Claude Code (cần ${min} trở lên). Safety Net chạy đến mức phiên bản này cho phép.`,
    nodeOk: v => `Có Node.js ${v}: snapshot lưu được cả file nhị phân và file lớn`,
    nodeMissing: 'Không thấy Node.js: snapshot chỉ lưu file văn bản đến 3 MB; có Node thì lưu được cả file nhị phân và file lớn',
    gitOk: v => `Có Git ${v}`,
    gitMissing: 'Không thấy Git: Safety Net vẫn lưu file, chỉ không chụp được trạng thái Git',
    folderOk: (dir, snapshots) => `Thư mục snapshot ${dir} ghi được: ${snapshots}`,
    folderFail: dir => `Không ghi được vào ${dir}: không lưu được snapshot, nhưng phần hỏi xác nhận và che bí mật vẫn chạy`,
    folderUnknown: dir => `Chưa kiểm tra được thư mục snapshot ${dir}; nó được tạo khi lưu snapshot đầu tiên`,
    snapshotCount: (count, size) => (whole(count) === 0 ? 'chưa có snapshot nào' : `${viCount(count, 'snapshot')}${size ? `, ${size}` : ''}`),
    totalNone: cap => `Chưa có snapshot nào ở bất kỳ dự án nào; tất cả cộng lại được chiếm tối đa ${cap}`,
    totalOk: (count, size, cap, isCut) => `${isCut ? 'Ít nhất ' : ''}${viCount(count, 'snapshot')} ở mọi dự án, ${size} (tối đa ${cap} cho tất cả)`,
    totalOver: (count, size, cap, isCut) =>
      `${isCut ? 'Ít nhất ' : ''}${viCount(count, 'snapshot')} ở mọi dự án, ${size}: vượt mức tối đa ${cap} cho tất cả, nên các snapshot cũ nhất sẽ bị xoá khi phiên sau bắt đầu`,
    helperOk: 'Script trợ giúp Node đã trả lời: file nhị phân và file lớn cũng được lưu',
    helperNo: 'Script trợ giúp Node không trả lời: snapshot chỉ lưu file văn bản đến 3 MB; có script thì lưu được cả file nhị phân và file lớn',
    helperUnknown: 'Chưa thử script trợ giúp Node: cho đến khi nó trả lời, snapshot chỉ lưu file văn bản đến 3 MB',
    options: (confirm, mask, language) => `Tuỳ chọn: ${confirm}; ${mask}; ngôn ngữ: ${language}`,
    confirmRisky: 'hỏi trước các lệnh xoá, ghi đè hoặc viết lại lịch sử',
    confirmAlways: 'hỏi trước các lệnh rủi ro và trước khi ghi đè bất kỳ file nào Git không theo dõi',
    confirmNever: 'không hỏi, nhưng vẫn lưu snapshot trước',
    confirmUnknown: value => `"${value}" không phải risky, always hay never nên sẽ hỏi trước các lệnh rủi ro`,
    maskOn: 'che bí mật trong kết quả của công cụ',
    maskOff: 'không che bí mật (đã tắt)',
    languageNames: { en: 'English', vi: 'Tiếng Việt' },
    surface: s => `Đang chạy trong: ${s}`,
    surfaceUnknown: 'Không có thông tin phiên này chạy ở đâu; không có gì phụ thuộc vào điều đó',
  },
}

export const TABLES: Record<Lang, Strings> = { en, vi }
/** The English table, for the words Claude reads. */
export const EN: Strings = en

export const stringsFor = (lang: Lang): Strings => TABLES[lang] ?? en

/** The `language` option: `en` and `vi` as they are, anything else (or a missing value) is `auto`. */
export function languageOption(value: unknown): 'auto' | Lang {
  return value === 'en' || value === 'vi' ? value : 'auto'
}

/** Claude Code's own `language` setting ("Vietnamese", "vi", "Tiếng Việt", "vi-VN") as a UI language; anything else is English. */
export function languageFromSetting(setting: unknown): Lang {
  if (typeof setting !== 'string') return 'en'
  return /^(?:vi(?![a-z])|viet|việt|tiếng\s*việt|tieng\s*viet)/i.test(setting.normalize('NFC').trim()) ? 'vi' : 'en'
}

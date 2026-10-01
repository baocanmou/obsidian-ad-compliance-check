import {
	compileRuleset,
	parseCustomWords,
	parseLines,
	parseNoteOptions,
	scan,
	type Hit,
	type RuleDef,
	type Ruleset,
} from './engine';
import { PACKS } from './packs';

export interface FolderRule {
	folder: string;
	packs: string[];
	words: string;
}

export interface ComplianceSettings {
	liveMark: boolean;
	enabledPacks: string[];
	customWords: string;
	whitelist: string;
	includeFolders: string;
	excludeFolders: string;
	folderRules: FolderRule[];
	switchKey: string;
	packsKey: string;
}

export function defaultSettings(): ComplianceSettings {
	return { ...DEFAULT_SETTINGS, enabledPacks: [...DEFAULT_SETTINGS.enabledPacks], folderRules: [] };
}

export const DEFAULT_SETTINGS: ComplianceSettings = {
	liveMark: true,
	enabledPacks: PACKS.filter((p) => p.defaultOn).map((p) => p.id),
	customWords: '',
	whitelist: '',
	includeFolders: '',
	excludeFolders: '',
	folderRules: [],
	switchKey: '合规检查',
	packsKey: '合规词库',
};

export interface Analysis {
	/** False when the note is not checked; `skipped` says why. */
	active: boolean;
	skipped?: 'scope' | 'switch' | 'length';
	hits: Hit[];
	packNames: string[];
}

/** Notes longer than this are not checked, to keep typing responsive. */
const MAX_LENGTH = 300_000;

function inFolder(path: string, folder: string): boolean {
	const f = folder.replace(/^\/+|\/+$/g, '');
	return f === '' || path === f || path.startsWith(f + '/');
}

export class Analyzer {
	private cache = new Map<string, Ruleset>();

	constructor(private settings: () => ComplianceSettings) {}

	/** Call after settings change. */
	reset(): void {
		this.cache.clear();
	}

	analyze(path: string | null, text: string): Analysis {
		const s = this.settings();
		const skip = (skipped: Analysis['skipped']): Analysis => ({ active: false, skipped, hits: [], packNames: [] });
		if (text.length > MAX_LENGTH) return skip('length');

		if (path !== null) {
			const include = parseLines(s.includeFolders);
			if (include.length && !include.some((f) => inFolder(path, f))) return skip('scope');
			if (parseLines(s.excludeFolders).some((f) => inFolder(path, f))) return skip('scope');
		}

		const note = parseNoteOptions(text, s.switchKey, s.packsKey);
		if (!note.enabled) return skip('switch');

		const folderRules = path === null ? [] : s.folderRules.filter((r) => r.folder.trim() && inFolder(path, r.folder));
		const wanted = new Set<string>([...s.enabledPacks, ...folderRules.flatMap((r) => r.packs), ...note.packs]);
		const packs = PACKS.filter((p) => wanted.has(p.id) || wanted.has(p.name));
		const folderWords = folderRules.map((r) => r.words).join('\n');

		const key = JSON.stringify([packs.map((p) => p.id), s.customWords, folderWords, s.whitelist]);
		let ruleset = this.cache.get(key);
		if (!ruleset) {
			const rules: Array<{ def: RuleDef; pack: string; custom?: boolean }> = [];
			for (const def of parseCustomWords(folderWords, '文件夹词库')) rules.push({ def, pack: '文件夹词库', custom: true });
			for (const def of parseCustomWords(s.customWords, '自定义词库')) rules.push({ def, pack: '自定义词库', custom: true });
			for (const p of packs) for (const def of p.rules) rules.push({ def, pack: p.name });
			ruleset = compileRuleset(rules, parseLines(s.whitelist));
			this.cache.set(key, ruleset);
		}

		const packNames = packs.map((p) => p.name);
		if (s.customWords.trim()) packNames.push('自定义词库');
		if (folderWords.trim()) packNames.push('文件夹词库');
		return { active: true, hits: scan(text, ruleset), packNames };
	}
}

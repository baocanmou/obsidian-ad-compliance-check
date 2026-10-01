import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { LEVEL_LABEL, type Hit, type Level } from './engine';
import type CompliancePlugin from './main';
import { DISCLAIMER, summary } from './report';

export const VIEW_TYPE = 'compliance-check';

const CONTEXT = 18;

export const SKIPPED = {
	scope: '这篇笔记不在检查范围内。',
	switch: '这篇笔记已在属性中关闭检查。',
	length: '这篇笔记超过 30 万字，未做检查。',
};

/** Side panel listing every risky expression in the note being edited. */
export class ComplianceView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private plugin: CompliancePlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return '合规检查';
	}

	getIcon(): string {
		return 'shield-check';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('compliance-view');

		const target = this.plugin.targetView();
		if (!target?.file) {
			root.createDiv({ cls: 'compliance-empty', text: '打开一篇笔记后，这里列出其中的风险表达。' });
			return;
		}
		const text = target.editor.getValue();
		const analysis = this.plugin.analyzer.analyze(target.file.path, text);

		const head = root.createDiv({ cls: 'compliance-head' });
		head.createDiv({ cls: 'compliance-title', text: target.file.basename });
		if (!analysis.active) {
			root.createDiv({ cls: 'compliance-empty', text: SKIPPED[analysis.skipped ?? 'scope'] });
			return;
		}
		head.createDiv({ cls: 'compliance-summary', text: summary(analysis.hits) });
		head.createDiv({ cls: 'compliance-packs', text: `词库：${analysis.packNames.join('、') || '无'}` });
		const copy = head.createEl('button', { text: '复制检查报告' });
		copy.addEventListener('click', () => void this.plugin.copyReport());

		for (const level of ['ban', 'caution', 'evidence'] as Level[]) {
			const hits = analysis.hits.filter((h) => h.level === level);
			if (!hits.length) continue;
			root.createDiv({ cls: 'compliance-group', text: `${LEVEL_LABEL[level]}（${hits.length}）` });
			for (const hit of hits) this.renderHit(root, hit, text);
		}
		root.createDiv({ cls: 'compliance-disclaimer', text: DISCLAIMER });
	}

	private renderHit(root: HTMLElement, hit: Hit, text: string): void {
		const item = root.createDiv({ cls: `compliance-item compliance-item-${hit.level}` });
		item.addEventListener('click', () => this.plugin.jumpTo(hit));

		const head = item.createDiv({ cls: 'compliance-item-head' });
		head.createSpan({ cls: `compliance-badge compliance-badge-${hit.level}`, text: LEVEL_LABEL[hit.level] });
		head.createSpan({ cls: 'compliance-item-term', text: hit.text });
		head.createSpan({ cls: 'compliance-item-line', text: `第 ${hit.line} 行` });

		const context = item.createDiv({ cls: 'compliance-item-context' });
		const before = text.slice(Math.max(0, hit.from - CONTEXT), hit.from).split('\n').pop() ?? '';
		const after = text.slice(hit.to, hit.to + CONTEXT).split('\n')[0] ?? '';
		context.appendText(before);
		context.createEl('mark', { text: hit.text });
		context.appendText(after);

		item.createDiv({ cls: 'compliance-item-reason', text: hit.reason });
		item.createDiv({ cls: 'compliance-item-basis', text: `依据：${hit.basis}` });
		for (const s of hit.suggest) {
			item.createDiv({ cls: 'compliance-item-advice', text: `建议：${s}` });
		}

		const actions = item.createDiv({ cls: 'compliance-item-actions' });
		for (const s of hit.replace) {
			const btn = actions.createEl('button', { text: `换成“${s}”` });
			btn.addEventListener('click', (evt) => {
				evt.stopPropagation();
				this.plugin.replaceHit(hit, s);
			});
		}
		const allow = actions.createEl('button', { text: '加入白名单' });
		allow.addEventListener('click', (evt) => {
			evt.stopPropagation();
			void this.plugin.addToWhitelist(hit.text);
		});
	}
}

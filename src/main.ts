import type { Extension } from '@codemirror/state';
import { MarkdownView, Notice, Plugin, debounce, type Editor } from 'obsidian';
import { complianceExtension } from './editor';
import type { Hit } from './engine';
import { buildReport, summary } from './report';
import { Analyzer, defaultSettings, type ComplianceSettings } from './ruleset';
import { ComplianceSettingTab } from './settings';
import { ComplianceView, SKIPPED, VIEW_TYPE } from './view';

export default class CompliancePlugin extends Plugin {
	settings: ComplianceSettings = defaultSettings();
	analyzer = new Analyzer(() => this.settings);

	private editorExtension: Extension[] = [];
	private statusBar: HTMLElement | null = null;
	/** Path of the note last edited, so the side panel keeps working while it has focus. */
	private targetPath: string | null = null;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf) => new ComplianceView(leaf, this));
		this.registerEditorExtension(this.editorExtension);
		this.applyEditorExtension();
		this.addSettingTab(new ComplianceSettingTab(this.app, this));

		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass('mod-clickable');
		this.registerDomEvent(this.statusBar, 'click', () => void this.openPanel());

		this.addRibbonIcon('shield-check', '合规检查', () => void this.openPanel());

		this.addCommand({ id: 'open-panel', name: '打开检查面板', callback: () => void this.openPanel() });
		this.addCommand({ id: 'copy-report', name: '复制检查报告', callback: () => void this.copyReport() });
		this.addCommand({
			id: 'next-hit',
			name: '跳到下一处风险表达',
			editorCallback: (editor, ctx) => this.nextHit(editor, ctx.file?.path ?? null),
		});
		this.addCommand({
			id: 'add-to-whitelist',
			name: '把选中文字加入白名单',
			editorCheckCallback: (checking, editor) => {
				const selection = editor.getSelection().trim();
				if (!selection || selection.includes('\n') || selection.startsWith('#')) return false;
				if (!checking) void this.addToWhitelist(selection);
				return true;
			},
		});
		this.addCommand({
			id: 'add-custom-word',
			name: '把选中文字加入自定义词库',
			editorCheckCallback: (checking, editor) => {
				const selection = editor.getSelection().trim();
				if (!selection || /[\n|｜]/.test(selection) || /^[#/]/.test(selection)) return false;
				if (!checking) void this.addCustomWord(selection);
				return true;
			},
		});
		this.addCommand({
			id: 'toggle-live-mark',
			name: '开关编辑器实时标注',
			callback: async () => {
				this.settings.liveMark = !this.settings.liveMark;
				await this.saveSettings();
				new Notice(this.settings.liveMark ? '已开启实时标注' : '已关闭实时标注');
			},
		});

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, info) => {
				const offset = editor.posToOffset(editor.getCursor());
				const hit = this.analyzer
					.analyze(info.file?.path ?? null, editor.getValue())
					.hits.find((h) => h.from <= offset && h.to >= offset);
				if (!hit) return;
				for (const s of hit.replace) {
					menu.addItem((item) =>
						item
							.setTitle(`合规：换成“${s}”`)
							.setIcon('replace')
							.onClick(() => {
								const from = editor.offsetToPos(hit.from);
								const to = editor.offsetToPos(hit.to);
								if (editor.getRange(from, to) === hit.text) editor.replaceRange(s, from, to);
							}),
					);
				}
				menu.addItem((item) =>
					item
						.setTitle(`合规：把“${hit.text}”加入白名单`)
						.setIcon('shield-check')
						.onClick(() => void this.addToWhitelist(hit.text)),
				);
			}),
		);

		const refresh = debounce(() => this.refreshPanels(), 300, true);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf?.view instanceof MarkdownView) {
					this.targetPath = leaf.view.file?.path ?? null;
					refresh();
				}
			}),
		);
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file) this.targetPath = file.path;
				refresh();
			}),
		);
		this.registerEvent(this.app.workspace.on('editor-change', () => refresh()));
		this.app.workspace.onLayoutReady(() => {
			this.targetPath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
			this.refreshPanels();
		});
	}

	async loadSettings() {
		this.settings = Object.assign(defaultSettings(), (await this.loadData()) as Partial<ComplianceSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.analyzer.reset();
		this.applyEditorExtension();
		this.app.workspace.updateOptions();
		this.refreshPanels();
	}

	private applyEditorExtension() {
		this.editorExtension.length = 0;
		if (this.settings.liveMark) this.editorExtension.push(complianceExtension(this));
	}

	analyze(path: string | null, text: string) {
		return this.analyzer.analyze(path, text);
	}

	/** The Markdown view the side panel and status bar describe. */
	targetView(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === this.targetPath) return leaf.view;
		}
		return null;
	}

	private refreshPanels() {
		const view = this.targetView();
		if (this.statusBar) {
			const analysis = view?.file ? this.analyze(view.file.path, view.editor.getValue()) : null;
			this.statusBar.setText(analysis?.active ? `合规：${summary(analysis.hits)}` : '');
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof ComplianceView) leaf.view.render();
		}
	}

	async openPanel() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: VIEW_TYPE, active: true });
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	jumpTo(hit: Hit) {
		const view = this.targetView();
		if (!view) return;
		const { editor } = view;
		if (editor.getRange(editor.offsetToPos(hit.from), editor.offsetToPos(hit.to)) !== hit.text) {
			this.refreshPanels();
			return;
		}
		this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
		this.select(editor, hit);
	}

	replaceHit(hit: Hit, replacement: string) {
		const editor = this.targetView()?.editor;
		if (!editor) return;
		const from = editor.offsetToPos(hit.from);
		const to = editor.offsetToPos(hit.to);
		if (editor.getRange(from, to) === hit.text) editor.replaceRange(replacement, from, to);
		this.refreshPanels();
	}

	private select(editor: Editor, hit: Hit) {
		const from = editor.offsetToPos(hit.from);
		const to = editor.offsetToPos(hit.to);
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
	}

	private nextHit(editor: Editor, path: string | null) {
		const { hits } = this.analyze(path, editor.getValue());
		if (!hits.length) {
			new Notice('未发现风险表达');
			return;
		}
		const offset = editor.posToOffset(editor.getCursor('to'));
		this.select(editor, hits.find((h) => h.from >= offset) ?? (hits[0] as Hit));
	}

	async copyReport() {
		const view = this.targetView();
		if (!view?.file) {
			new Notice('请先打开一篇笔记');
			return;
		}
		const analysis = this.analyze(view.file.path, view.editor.getValue());
		if (!analysis.active) {
			new Notice(SKIPPED[analysis.skipped ?? 'scope']);
			return;
		}
		const date = window.moment().format('YYYY-MM-DD HH:mm');
		await navigator.clipboard.writeText(buildReport(view.file.basename, analysis, date));
		new Notice('检查报告已复制');
	}

	async addToWhitelist(term: string) {
		const lines = this.settings.whitelist.split('\n').map((l) => l.trim());
		if (!lines.includes(term)) {
			this.settings.whitelist = [...lines.filter(Boolean), term].join('\n');
			await this.saveSettings();
		}
		new Notice(`已把“${term}”加入白名单`);
	}

	private async addCustomWord(term: string) {
		const lines = this.settings.customWords.split('\n').filter((l) => l.trim());
		this.settings.customWords = [...lines, `${term} | 慎用`].join('\n');
		await this.saveSettings();
		new Notice(`已把“${term}”加入自定义词库，可在设置里补充级别和替换词`);
	}
}

import { App, Modal, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type CompliancePlugin from './main';
import { PACKS, termCount } from './packs';
import { DISCLAIMER } from './report';
import type { FolderRule } from './ruleset';

const WORD_FORMAT = '每行一条：词语 | 级别 | 建议 | 说明。只有词语必填；级别写禁用、慎用或需依据，不写按慎用；多个建议用顿号隔开。';

export class ComplianceSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: CompliancePlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName('编辑器实时标注')
			.setDesc('写作时在风险表达下方画线，鼠标停留显示原因和建议。关闭后仍可在侧边面板查看。')
			.addToggle((t) =>
				t.setValue(s.liveMark).onChange(async (v) => {
					s.liveMark = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName('词库').setDesc('开启的词库对所有笔记生效。行业词库建议按文件夹或单篇笔记开启。').setHeading();
		for (const pack of PACKS) {
			new Setting(containerEl)
				.setName(pack.name)
				.setDesc(`${pack.desc}共 ${termCount(pack)} 条。`)
				.addToggle((t) =>
					t.setValue(s.enabledPacks.includes(pack.id)).onChange(async (v) => {
						s.enabledPacks = s.enabledPacks.filter((id) => id !== pack.id);
						if (v) s.enabledPacks.push(pack.id);
						await this.plugin.saveSettings();
					}),
				);
		}

		new Setting(containerEl)
			.setName('自定义词库')
			.setDesc(`${WORD_FORMAT}例：门店第一 | 禁用 | 本地开业较早 | 无排名依据`)
			.setClass('compliance-setting-area')
			.addTextArea((t) =>
				t
					.setPlaceholder('词语 | 级别 | 建议 | 说明')
					.setValue(s.customWords)
					.onChange(async (v) => {
						s.customWords = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('白名单')
			.setDesc('每行一个词或短语。出现在白名单短语里的词不再提示，例如把“第一食品厂”加入后，其中的“第一”不再标注。')
			.setClass('compliance-setting-area')
			.addTextArea((t) =>
				t.setValue(s.whitelist).onChange(async (v) => {
					s.whitelist = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName('检查范围').setHeading();
		new Setting(containerEl)
			.setName('只检查这些文件夹')
			.setDesc('每行一个文件夹路径。留空表示检查所有笔记。')
			.setClass('compliance-setting-area')
			.addTextArea((t) =>
				t.setValue(s.includeFolders).onChange(async (v) => {
					s.includeFolders = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName('不检查这些文件夹')
			.setDesc('每行一个文件夹路径。')
			.setClass('compliance-setting-area')
			.addTextArea((t) =>
				t.setValue(s.excludeFolders).onChange(async (v) => {
					s.excludeFolders = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('按文件夹加严')
			.setDesc('给某个客户或栏目的文件夹追加行业词库和专用词语，只对该文件夹下的笔记生效。')
			.setHeading();
		s.folderRules.forEach((rule, index) => {
			const names = PACKS.filter((p) => rule.packs.includes(p.id)).map((p) => p.name);
			const words = rule.words.split('\n').filter((l) => l.trim()).length;
			new Setting(containerEl)
				.setName(rule.folder || '（未填写文件夹）')
				.setDesc(`追加词库：${names.join('、') || '无'}；专用词语 ${words} 条`)
				.addButton((b) =>
					b.setButtonText('编辑').onClick(() => {
						new FolderRuleModal(this.app, rule, async () => {
							await this.plugin.saveSettings();
							this.display();
						}).open();
					}),
				)
				.addExtraButton((b) =>
					b
						.setIcon('trash-2')
						.setTooltip('删除')
						.onClick(async () => {
							s.folderRules.splice(index, 1);
							await this.plugin.saveSettings();
							this.display();
						}),
				);
		});
		new Setting(containerEl).addButton((b) =>
			b.setButtonText('添加文件夹规则').onClick(() => {
				const rule: FolderRule = { folder: '', packs: [], words: '' };
				new FolderRuleModal(this.app, rule, async () => {
					s.folderRules.push(rule);
					await this.plugin.saveSettings();
					this.display();
				}).open();
			}),
		);

		new Setting(containerEl)
			.setName('单篇笔记设置')
			.setDesc('在笔记属性里写“合规词库: [疾病与医疗用语, 教育培训]”可为这一篇追加词库；写“合规检查: false”可关闭这一篇的检查。')
			.setHeading();
		new Setting(containerEl)
			.setName('词库属性名')
			.addText((t) =>
				t.setValue(s.packsKey).onChange(async (v) => {
					s.packsKey = v.trim() || '合规词库';
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName('开关属性名')
			.addText((t) =>
				t.setValue(s.switchKey).onChange(async (v) => {
					s.switchKey = v.trim() || '合规检查';
					await this.plugin.saveSettings();
				}),
			);

		containerEl.createEl('p', { cls: 'compliance-disclaimer', text: DISCLAIMER });
	}
}

class FolderRuleModal extends Modal {
	constructor(
		app: App,
		private rule: FolderRule,
		private onSave: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, rule } = this;
		this.setTitle('文件夹规则');
		const draft: FolderRule = { folder: rule.folder, packs: [...rule.packs], words: rule.words };

		new Setting(contentEl)
			.setName('文件夹')
			.setDesc('从库根目录开始的路径，对其下所有笔记生效。')
			.addText((t) =>
				t
					.setPlaceholder('客户项目/某客户')
					.setValue(draft.folder)
					.onChange((v) => (draft.folder = v)),
			);

		for (const pack of PACKS) {
			new Setting(contentEl)
				.setName(pack.name)
				.setDesc(pack.desc)
				.addToggle((t) =>
					t.setValue(draft.packs.includes(pack.id)).onChange((v) => {
						draft.packs = draft.packs.filter((id) => id !== pack.id);
						if (v) draft.packs.push(pack.id);
					}),
				);
		}

		new Setting(contentEl)
			.setName('专用词语')
			.setDesc(WORD_FORMAT)
			.setClass('compliance-setting-area')
			.addTextArea((t) => t.setValue(draft.words).onChange((v) => (draft.words = v)));

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText('保存')
				.setCta()
				.onClick(async () => {
					const folder = draft.folder.trim();
					rule.folder = folder ? normalizePath(folder) : '';
					rule.packs = draft.packs;
					rule.words = draft.words;
					await this.onSave();
					this.close();
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

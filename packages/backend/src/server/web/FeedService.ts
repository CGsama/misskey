/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In, IsNull } from 'typeorm';
import { Feed } from 'feed';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository, NotesRepository, UserProfilesRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import type { MiUser } from '@/models/User.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { MfmService } from "@/core/MfmService.js";
import { parse as mfmParse } from 'mfm-js';
import { MiNote } from '@/models/Note.js';
import { isQuote, isRenote } from '@/misc/is-renote.js';
import { getNoteSummary } from '@/misc/get-note-summary.js';

@Injectable()
export class FeedService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private userEntityService: UserEntityService,
		private driveFileEntityService: DriveFileEntityService,
		private idService: IdService,
		private mfmService: MfmService,
	) {
	}

	@bindThis
	public async packFeed(user: MiUser) {
		const author = {
			link: `${this.config.url}/@${user.username}`,
			name: user.name ?? user.username,
		};

		const profile = await this.userProfilesRepository.findOneByOrFail({ userId: user.id });

		const notes = await this.notesRepository.find({
			where: {
				userId: user.id,
				renoteId: IsNull(),
				visibility: In(['public', 'home']),
			},
			order: { id: -1 },
			take: 20,
		});

		const feed = new Feed({
			id: author.link,
			title: `${author.name} (@${user.username}@${this.config.host})`,
			updated: notes.length !== 0 ? this.idService.parse(notes[0].id).date : undefined,
			generator: 'Misskey',
			description: `${user.notesCount} Notes, ${profile.followingVisibility === 'public' ? user.followingCount : '?'} Following, ${profile.followersVisibility === 'public' ? user.followersCount : '?'} Followers${profile.description ? ` · ${profile.description}` : ''}`,
			link: author.link,
			image: user.avatarUrl ?? this.userEntityService.getIdenticonUrl(user),
			feedLinks: {
				json: `${author.link}.json`,
				atom: `${author.link}.atom`,
			},
			author,
			copyright: user.name ?? user.username,
		});

		for (const note of notes) {
			let contentStr = await this.noteToString(note, true);
			let next = note.renoteId ? note.renoteId : note.replyId;
			let depth = 10;
			let noteintitle = true;
			let title = `Post by ${author.name}`;
			while (depth > 0 && next) {
				const finding = await this.findById(next);
				contentStr += finding.text;
				next = finding.next;
				depth -= 1;
			}

			if (noteintitle) {
				if (note.renoteId) {
					title = `Boost by ${author.name}`;
				} else if (note.replyId) {
					title = `Reply by ${author.name}`;
				} else {
					title = `Post by ${author.name}`;
				}
				const effectiveNote =
					!isQuote(note) && note.renote != null ? note.renote : note;
				const content = getNoteSummary(effectiveNote);
				if (content) {
					title += `: ${content}`;
				}
			}

			feed.addItem({
				title: `New note by ${author.name}`,
				link: `${this.config.url}/notes/${note.id}`,
				date: this.idService.parse(note.id).date,
				description: note.cw ?? undefined,
				content: contentStr || undefined,
			});
		}

		return feed;
	}

	private async noteToString(note: MiNote, isTheNote = false) {
		const author = isTheNote
			? null
			: await this.userProfilesRepository.findOneByOrFail({ userId: note.userId });
		let outstr = author
			? `${author.name}(@${author.username}@${
					author.host ? author.host : this.config.host
				}) ${
					note.renoteId ? "renotes" : note.replyId ? "replies" : "says"
				}: <br>`
			: "";
		const files = note.fileIds.length > 0 ? await this.driveFilesRepository.findBy({
			id: In(note.fileIds),
		}) : [];
		let fileEle = "";
		for (const file of files) {
			if (file.type.startsWith("image/")) {
				fileEle += ` <br><img src="${this.driveFileEntityService.getPublicUrl(file)}">`;
			} else if (file.type.startsWith("audio/")) {
				fileEle += ` <br><audio controls src="${this.driveFileEntityService.getPublicUrl(
					file,
				)}" type="${file.type}">`;
			} else if (file.type.startsWith("video/")) {
				fileEle += ` <br><video controls src="${this.driveFileEntityService.getPublicUrl(
					file,
				)}" type="${file.type}">`;
			} else {
				fileEle += ` <br><a href="${this.driveFileEntityService.getPublicUrl(file)}" download="${
					file.name
				}">${file.name}</a>`;
			}
		}

		outstr += `${note.cw ? note.cw + "<br>" : ""}${
			(note.text ? this.mfmService.toHtml(mfmParse(note.text), JSON.parse(note.mentionedRemoteUsers)) ?? undefined : undefined) || ""
		}${fileEle}`;
		if (isTheNote) {
			outstr += ` <span class="${
				note.renoteId ? "renote_note" : note.replyId ? "reply_note" : "new_note"
			} ${
				fileEle.indexOf("img src") !== -1 ? "with_img" : "without_img"
			}"></span>`;
		}
		return outstr;
	}

	private async findById(id : String) {
		let text = "";
		let next = null;
		const findings = await this.notesRepository.find({
			where: {
				id: id,
				renoteId: IsNull(),
				visibility: In(['public', 'home']),
			},
			order: { id: -1 },
			take: 1,
		});
		if (findings) {
			text += `<hr>`;
			text += await this.noteToString(findings);
			next = findings.renoteId ? findings.renoteId : findings.replyId;
		}
		return { text, next };
	}
}

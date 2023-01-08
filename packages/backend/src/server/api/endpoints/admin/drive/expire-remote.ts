import { deleteFile } from '@/services/drive/delete-file.js';
import { publishDriveStream } from '@/services/stream.js';
import define from '../../../define.js';
import { ApiError } from '../../../error.js';
import { DriveFiles, Users } from '@/models/index.js';
import { IRemoteUser, User } from '@/models/entities/user.js';
import { fetchMeta } from '@/misc/fetch-meta.js';

export const meta = {
	tags: ['drive'],

	requireCredential: true,

	kind: 'write:drive',

	description: 'Expire an existing remote drive file.',

	errors: {
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: '5eb8d909-2540-4970-90b8-dd6f86088121',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		fileId: { type: 'string', format: 'misskey:id' },
	},
	required: ['userId'],
} as const;

async function deleteOldFile(user: IRemoteUser) {
	const q = DriveFiles.createQueryBuilder('file')
		.where('file.userId = :userId', { userId: user.id })
		.andWhere('file.isLink = FALSE');

	if (user.avatarId) {
		q.andWhere('file.id != :avatarId', { avatarId: user.avatarId });
	}

	if (user.bannerId) {
		q.andWhere('file.id != :bannerId', { bannerId: user.bannerId });
	}
	q.addSelect('SUM("file"."size") OVER (ORDER BY "file"."id" DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)', 'acc_usage');
	q.orderBy('file.id', 'ASC');

	const fileList = await q.getRawMany();
	const instance = await fetchMeta();
	const driveCapacity = 1024 * 1024 * instance.remoteDriveCapacityMb;
	const exceedFileIds = fileList.filter((x: any) => x.acc_usage > driveCapacity).map((x: any) => x.file_id);

	for (const fileId of exceedFileIds) {
		const file = await DriveFiles.findOneBy({ id: fileId });
		deleteFile(file, true);
	}

	return exceedFileIds;
}

// eslint-disable-next-line import/no-default-export
export default define(meta, paramDef, async (ps, user) => {
	const u = await Users.findOneBy({ id: ps.userId });
	if (Users.isLocalUser(u)) {
		return;
	}

	const remoteUser = await Users.findOneByOrFail({ id: u.id }) as IRemoteUser

	if (!user.isAdmin) {
		throw new ApiError(meta.errors.accessDenied);
	}

	deleteOldFile(remoteUser);
});

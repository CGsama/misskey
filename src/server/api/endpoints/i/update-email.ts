import $ from 'cafy';
import { publishMainStream } from '../../../../services/stream';
import define from '../../define';
import rndstr from 'rndstr';
import config from '../../../../config';
import * as ms from 'ms';
import * as bcrypt from 'bcryptjs';
import { Users, UserProfiles } from '../../../../models';
import { ensure } from '../../../../prelude/ensure';
import { sendEmail } from '../../../../services/send-email';

export const meta = {
	requireCredential: true,

	secure: true,

	limit: {
		duration: ms('1hour'),
		max: 3
	},

	params: {
		password: {
			validator: $.str
		},

		email: {
			validator: $.optional.nullable.str
		},
	}
};

export default define(meta, async (ps, user) => {
	const profile = await UserProfiles.findOne(user.id).then(ensure);

	// Compare password
	const same = await bcrypt.compare(ps.password, profile.password!);

	if (!same) {
		throw new Error('incorrect password');
	}

	await UserProfiles.update({ userId: user.id }, {
		email: ps.email,
		emailVerified: false,
		emailVerifyCode: null
	});

	const iObj = await Users.pack(user.id, user, {
		detail: true,
		includeSecrets: true
	});

	// Publish meUpdated event
	publishMainStream(user.id, 'meUpdated', iObj);

	if (ps.email != null) {
		const code = rndstr('a-z0-9', 16);

		await UserProfiles.update({ userId: user.id }, {
			emailVerifyCode: code
		});

		const link = `${config.url}/verify-email/${code}`;

		sendEmail(ps.email, 'Email verification', `To verify email, please click this link: ${link}`);
	}

	return iObj;
});

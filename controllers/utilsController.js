const path = require('path');
const config = require('../config.js');
const fs = require('fs');
const gm = require('gm');
const ffmpeg = require('fluent-ffmpeg');
const db = require('knex')(config.database);

const uploadsDir = path.join(__dirname, '..', config.uploads.folder);
const utilsController = {};
utilsController.imageExtensions = ['.jpg', '.jpeg', '.bmp', '.gif', '.png'];
utilsController.videoExtensions = ['.webm', '.mp4', '.wmv', '.avi', '.mov'];
const thumbsDir = path.join(uploadsDir, 'thumbs');

utilsController.getPrettyDate = function(date) {
	return `${date.getFullYear()}-${
		date.getMonth() + 1}-${
		date.getDate()} ${
		date.getHours() < 10 ? '0' : ''
	}${date.getHours()}:${
		date.getMinutes() < 10 ? '0' : ''
	}${date.getMinutes()}:${
		date.getSeconds() < 10 ? '0' : ''
	}${date.getSeconds()}`;
};

utilsController.extname = filename => {
	// Always return blank string if the filename does not seem to have a valid extension
	// Files such as .DS_Store (anything that starts with a dot, without any extension after) will still be accepted
	if (!/\../.test(filename)) return '';

	let lower = filename.toLowerCase(); // Due to this, the returned extname will always be lower case
	let multi = '';
	let extname = '';

	// Check for multi-archive extensions (.001, .002, and so on)
	if (/\.\d{3}$/.test(lower)) {
		multi = lower.slice(lower.lastIndexOf('.') - lower.length);
		lower = lower.slice(0, lower.lastIndexOf('.'));
	}

	// Check against extensions that must be preserved
	for (let i = 0; i < utilsController.preserves.length; i++) {
		if (lower.endsWith(utilsController.preserves[i])) {
			extname = utilsController.preserves[i];
			break;
		}
	}

	if (!extname) { extname = lower.slice(lower.lastIndexOf('.') - lower.length); } // Path.extname(lower)

	return extname + multi;
};

utilsController.authorize = async (req, res) => {
	const token = req.headers.token;
	if (token === undefined) return res.status(401).json({ success: false, description: 'No token provided' });

	const user = await db.table('users').where('token', token).first();
	if (!user) return res.status(401).json({ success: false, description: 'Invalid token' });
	return user;
};

utilsController.deleteFile = (filename, set) => new Promise((resolve, reject) => {
	const extname = utilsController.extname(filename);
	return fs.unlink(path.join(uploadsDir, filename), error => {
		if (error && error.code !== 'ENOENT') return reject(error);
		const identifier = filename.split('.')[0];
		// eslint-disable-next-line curly
		if (set) {
			set.delete(identifier);
			// Console.log(`Removed ${identifier} from identifiers cache (deleteFile)`)
		}
		if (utilsController.imageExtensions.includes(extname) || utilsController.videoExtensions.includes(extname)) {
			const thumb = `${identifier}.png`;
			return fs.unlink(path.join(thumbsDir, thumb), error => {
				if (error && error.code !== 'ENOENT') return reject(error);
				resolve(true);
			});
		}
		resolve(true);
	});
});

utilsController.generateThumbs = function(file, basedomain) {
	if (config.uploads.generateThumbnails !== true) return;
	const ext = path.extname(file.name).toLowerCase();

	let thumbname = path.join(__dirname, '..', config.uploads.folder, 'thumbs', `${file.name.slice(0, -ext.length)}.png`);
	fs.access(thumbname, err => {
		if (err && err.code === 'ENOENT') {
			if (utilsController.videoExtensions.includes(ext)) {
				ffmpeg(path.join(__dirname, '..', config.uploads.folder, file.name))
					.thumbnail({
						timestamps: [0],
						filename: '%b.png',
						folder: path.join(__dirname, '..', config.uploads.folder, 'thumbs'),
						size: '200x?'
					})
					.on('error', error => console.log('Error - ', error.message));
			} else {
				let size = {
					width: 200,
					height: 200
				};
				gm(path.join(__dirname, '..', config.uploads.folder, file.name))
					.resize(size.width, `${size.height}>`)
					.gravity('Center')
					.extent(size.width, size.height)
					.background('transparent')
					.write(thumbname, error => {
						if (error) console.log('Error - ', error);
					});
			}
		}
	});
};


module.exports = utilsController;

const config = require('../config.js');
const path = require('path');
const multer = require('multer');
const randomstring = require('randomstring');
const db = require('knex')(config.database);
const crypto = require('crypto');
const fs = require('fs');
const utils = require('./utilsController.js');

const uploadsController = {};

// Let's default it to only 1 try
const maxTries = config.uploads.maxTries || 1;
const uploadDir = path.join(__dirname, '..', config.uploads.folder);

const storage = multer.diskStorage({
	destination: function(req, file, cb) {
		cb(null, uploadDir);
	},
  	filename: function(req, file, cb) {
		const access = i => {
			const name = randomstring.generate(config.uploads.fileLength) + path.extname(file.originalname);
			fs.access(path.join(uploadDir, name), err => {
				if (err) return cb(null, name);
				console.log(`A file named "${name}" already exists (${++i}/${maxTries}).`);
				if (i < maxTries) return access(i);
				return cb('Could not allocate a unique file name. Try again?');
			});
		};
		access(0);
	}
});

const upload = multer({
	storage: storage,
	limits: { fileSize: config.uploads.maxSize },
	fileFilter: function(req, file, cb) {
		if (config.blockedExtensions !== undefined) {
			if (config.blockedExtensions.some(extension => path.extname(file.originalname).toLowerCase() === extension)) {
				return cb('This file extension is not allowed');
			}
			return cb(null, true);
		}
		return cb(null, true);
	}
}).array('files[]');

uploadsController.upload = async (req, res, next) => {
	if (config.private === true) {
		await utils.authorize(req, res);
	}

	const token = req.headers.token || '';
	const user = await db.table('users').where('token', token).first();
	if (user && (user.enabled === false || user.enabled === 0)) {
		return res.json({
			success: false,
			description: 'This account has been disabled'
		});
	}
	const albumid = req.headers.albumid || req.params.albumid;

	if (albumid && user) {
		const album = await db.table('albums').where({ id: albumid, userid: user.id }).first();
		if (!album) {
			return res.json({
				success: false,
				description: 'Album doesn\'t exist or it doesn\'t belong to the user'
			});
		}
		return uploadsController.actuallyUpload(req, res, user, albumid);
	}
	return uploadsController.actuallyUpload(req, res, user, albumid);
};

uploadsController.actuallyUpload = async (req, res, userid, album) => {
	const erred = error => {
		const isError = error instanceof Error;
		if (isError) console.error(error);
		res.status(400).json({
		  success: false,
		  description: isError ? error.toString() : error
		});
	  };

	upload(req, res, async err => {
		if (err) {
			console.error(err);
			return res.json({ success: false, description: err });
		}

		if (req.files.length === 0) return res.json({ success: false, description: 'no-files' });

		const files = [];
		const existingFiles = [];
		let iteration = 1;

		const infoMap = req.files.map(file => {
			file.albumid = album;
			return {
			  path: path.join(__dirname, '..', config.uploads.folder, file.filename),
			  data: file
			};
		  });

		  if (config.filterEmptyFile && infoMap.some(file => file.data.size === 0)) {
			infoMap.forEach(file => {
			  utils.deleteFile(file.data.filename, req.app.get('uploads-set')).catch(console.error);
			});
			return erred('Empty files are not allowed.');
		  }

		if (config.uploads.scan && config.uploads.scan.enabled) {
			const scan = await uploadsController.scanFiles(req, infoMap);
			if (scan) return erred(scan);
		  }

		req.files.forEach(async file => {
			// Check if the file exists by checking hash and size
			let hash = crypto.createHash('md5');
			let stream = fs.createReadStream(path.join(__dirname, '..', config.uploads.folder, file.filename));

			stream.on('data', data => {
				hash.update(data, 'utf8');
			});

			stream.on('end', async () => {
				const fileHash = hash.digest('hex');
				const dbFile = await db.table('files')
					.where(function() {
						if (userid === undefined) this.whereNull('userid');
						else this.where('userid', userid.id);
					})
					.where({
						hash: fileHash,
						size: file.size
					})
					.first();

				if (!dbFile) {
					files.push({
						name: file.filename,
						original: file.originalname,
						type: file.mimetype,
						size: file.size,
						hash: fileHash,
						ip: req.ip,
						albumid: album,
						userid: userid !== undefined ? userid.id : null,
						timestamp: Math.floor(Date.now() / 1000)
					});
				} else {
					uploadsController.deleteFile(file.filename).then(() => {}).catch(err => console.error(err));
					existingFiles.push(dbFile);
				}

				if (iteration === req.files.length) {
					return uploadsController.processFilesForDisplay(req, res, files, existingFiles);
				}
				iteration++;
			});
		});
	});
};

uploadsController.processFilesForDisplay = async (req, res, files, existingFiles) => {
	let basedomain = config.domain;
	if (files.length === 0) {
		return res.json({
			success: true,
			files: existingFiles.map(file => ({
				name: file.name,
				size: file.size,
				url: `${basedomain}/${file.name}`
			}))
		});
	}

	await db.table('files').insert(files);
	for (let efile of existingFiles) files.push(efile);

	res.json({
		success: true,
		files: files.map(file => ({
			name: file.name,
			size: file.size,
			url: `${basedomain}/${file.name}`
		}))
	});

	for (let file of files) {
		let ext = path.extname(file.name).toLowerCase();
		if (utils.imageExtensions.includes(ext) || utils.videoExtensions.includes(ext)) {
			file.thumb = `${basedomain}/thumbs/${file.name.slice(0, -ext.length)}.png`;
			utils.generateThumbs(file);
		}

		if (file.albumid) {
			db.table('albums').where('id', file.albumid).update('editedAt', file.timestamp)
				.then(() => {})
				.catch(error => { console.log(error); res.json({ success: false, description: 'Error updating album' }); });
		}
	}
};

uploadsController.scanFiles = (req, infoMap) => new Promise(async (resolve, reject) => {
	  const scanner = req.app.get('clam-scanner');
	  let iteration = 0;
	  for (const info of infoMap) {
		scanner.scanFile(info.path).then(reply => {
		  if (!reply.includes('OK') || reply.includes('FOUND')) {
			// eslint-disable-next-line no-control-regex
				const virus = reply.replace(/^stream: /, '').replace(/ FOUND\u0000$/, '');
				console.log(`ClamAV: ${info.data.filename}: ${virus} FOUND.`);
				return resolve(virus);
		  }

		  iteration++;
		  if (iteration === infoMap.length) { resolve(null); }
		}).catch(reject)
		;
	}
}).then(virus => {
	  if (!virus) return false;
	  // If there is at least one dirty file, then delete all files
	  const set = req.app.get('uploads-set');
	  infoMap.forEach(info => {
		utils.deleteFile(info.data.filename).catch(console.error);
		if (set) {
		  const identifier = info.data.filename.split('.')[0];
		  set.delete(identifier);
		  // Console.log(`Removed ${identifier} from identifiers cache (formatInfoMap)`)
		}
	  });
	  // Unfortunately, we will only be returning name of the first virus
	  // even if the current session was made up by multiple virus types
	  return `Virus detected: ${virus}.`;
}).catch(error => {
	  console.error(`ClamAV: ${error.toString()}.`);
	  return `ClamAV: ${error.code}, please contact site owner.`;
});

uploadsController.delete = async (req, res) => {
	const user = await utils.authorize(req, res);
	const id = req.body.id;
	if (id === undefined || id === '') {
		return res.json({ success: false, description: 'No file specified' });
	}

	const file = await db.table('files')
		.where('id', id)
		.where(function() {
			if (user.username !== 'root') {
				this.where('userid', user.id);
			}
		})
		.first();

	try {
		await uploadsController.deleteFile(file.name);
		await db.table('files').where('id', id).del();
		if (file.albumid) {
			await db.table('albums').where('id', file.albumid).update('editedAt', Math.floor(Date.now() / 1000));
		}
	} catch (err) {
		console.log(err);
	}

	return res.json({ success: true });
};

uploadsController.deleteFile = function(file) {
	const ext = path.extname(file).toLowerCase();
	return new Promise((resolve, reject) => {
		fs.stat(path.join(__dirname, '..', config.uploads.folder, file), (err, stats) => {
			if (err) { return reject(err); }
			fs.unlink(path.join(__dirname, '..', config.uploads.folder, file), err => {
				if (err) { return reject(err); }
				if (!utils.imageExtensions.includes(ext) && !utils.videoExtensions.includes(ext)) {
					return resolve();
				}
				file = `${file.substr(0, file.lastIndexOf('.'))}.png`;
				fs.stat(path.join(__dirname, '..', config.uploads.folder, 'thumbs/', file), (err, stats) => {
					if (err) {
						console.log(err);
						return resolve();
					}
					fs.unlink(path.join(__dirname, '..', config.uploads.folder, 'thumbs/', file), err => {
						if (err) { return reject(err); }
						return resolve();
					});
				});
			});
		});
	});
};

uploadsController.list = async (req, res) => {
	const user = await utils.authorize(req, res);

	let offset = req.params.page;
	if (offset === undefined) offset = 0;

	const files = await db.table('files')
		.where(function() {
			if (req.params.id === undefined) this.where('id', '<>', '');
			else this.where('albumid', req.params.id);
		})
		.where(function() {
			if (user.username !== 'root') this.where('userid', user.id);
		})
		.orderBy('id', 'DESC')
		.limit(25)
		.offset(25 * offset)
		.select('id', 'albumid', 'timestamp', 'name', 'userid');

	const albums = await db.table('albums');
	let basedomain = config.domain;
	let userids = [];

	for (let file of files) {
		file.file = `${basedomain}/${file.name}`;
		file.date = new Date(file.timestamp * 1000);
		file.date = utils.getPrettyDate(file.date);

		file.album = '';

		if (file.albumid !== undefined) {
			for (let album of albums) {
				if (file.albumid === album.id) {
					file.album = album.name;
				}
			}
		}

		// Only push usernames if we are root
		if (user.username === 'root') {
			if (file.userid !== undefined && file.userid !== null && file.userid !== '') {
				userids.push(file.userid);
			}
		}

		let ext = path.extname(file.name).toLowerCase();
		if (utils.imageExtensions.includes(ext) || utils.videoExtensions.includes(ext)) {
			file.thumb = `${basedomain}/thumbs/${file.name.slice(0, -ext.length)}.png`;
		}
	}

	// If we are a normal user, send response
	if (user.username !== 'root') return res.json({ success: true, files });

	// If we are root but there are no uploads attached to a user, send response
	if (userids.length === 0) return res.json({ success: true, files });

	const users = await db.table('users').whereIn('id', userids);
	for (let dbUser of users) {
		for (let file of files) {
			if (file.userid === dbUser.id) {
				file.username = dbUser.username;
			}
		}
	}

	return res.json({ success: true, files });
};

module.exports = uploadsController;

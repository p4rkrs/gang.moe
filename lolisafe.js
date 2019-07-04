const config = require('./config.js');
const api = require('./routes/api.js');
const album = require('./routes/album.js');
const express = require('express');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const RateLimit = require('express-rate-limit');
const db = require('knex')(config.database);
const fs = require('fs');
const exphbs = require('express-handlebars');
const clamd = require('clamdjs');
const safe = express();

require('./database/db.js')(db);

fs.existsSync('./pages/custom') || fs.mkdirSync('./pages/custom');
fs.existsSync(`./${config.logsFolder}`) || fs.mkdirSync(`./${config.logsFolder}`);
fs.existsSync(`./${config.uploads.folder}`) || fs.mkdirSync(`./${config.uploads.folder}`);
fs.existsSync(`./${config.uploads.folder}/thumbs`) || fs.mkdirSync(`./${config.uploads.folder}/thumbs`);
fs.existsSync(`./${config.uploads.folder}/zips`) || fs.mkdirSync(`./${config.uploads.folder}/zips`);

safe.use(helmet());
safe.set('trust proxy', 1);

safe.engine('handlebars', exphbs({ defaultLayout: 'main' }));
safe.set('view engine', 'handlebars');
safe.enable('view cache');

let limiter = new RateLimit({ windowMs: 5000, max: 2 });
safe.use('/api/login/', limiter);
safe.use('/api/register/', limiter);
safe.use('/api/delete/', limiter);

safe.use(bodyParser.urlencoded({ extended: true }));
safe.use(bodyParser.json());

if (config.serveFilesWithNode) {
	safe.use('/', express.static(config.uploads.folder));
}

safe.use('/', express.static('./public'));
safe.use('/', album);
safe.use('/api', api);

const start = async () => {
	const scan = config.uploads.scan;
	if (scan && scan.enabled) {
	  const created = await new Promise(async (resolve, reject) => {
			if (!scan.ip || !scan.port) { return reject(new Error('clamd IP or port is missing')); }

			const ping = await clamd.ping(scan.ip, scan.port).catch(reject);
			if (!ping) { return reject(new Error('Could not ping clamd')); }

			const version = await clamd.version(scan.ip, scan.port).catch(reject);
			console.log(`${scan.ip}:${scan.port} ${version}`);

			const scanner = clamd.createScanner(scan.ip, scan.port);
			safe.set('clam-scanner', scanner);
			return resolve(true);
	  }).catch(error => console.error(error.toString()));
	  if (!created) return process.exit(1);
	}

	safe.listen(config.port, () => console.log(`gang.moe started on port ${config.port}`));
};

for (let page of config.pages) {
	let root = './pages/';
	if (fs.existsSync(`./pages/custom/${page}.html`)) {
		root = './pages/custom/';
	}
	if (page === 'home') {
		safe.get('/', (req, res, next) => res.sendFile(`${page}.html`, { root: root }));
	} else {
		safe.get(`/${page}`, (req, res, next) => res.sendFile(`${page}.html`, { root: root }));
	}
}

safe.use((req, res, next) => res.status(404).sendFile('404.html', { root: './pages/error/' }));
safe.use((req, res, next) => res.status(500).sendFile('500.html', { root: './pages/error/' }));

start();

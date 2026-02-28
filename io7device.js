import {Client, connect} from 'mqtt';
import {existsSync, writeFile, readFileSync, copyFileSync, readdirSync, mkdirSync, appendFileSync } from 'fs';
import prompt from 'prompt-sync';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';
import http from 'http';

const getInput = prompt(); // Assuming you need only the prompt functionality

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cfg_file = 'device.cfg';

function isValidURL(string) {
    try {
       new URL(string);
        return true;
    } catch (err) {
        return false;
    }
}

function rotateFile(source) {
    const archiveDir = './archive';
    if (!existsSync(archiveDir)) {
        mkdirSync(archiveDir);
    }
    const filePattern = new RegExp(`^${source}\\.js\\.(\\d+)$`);
    const files = readdirSync(archiveDir);
    const matchingFiles = files
        .map(file => {
            const match = file.match(filePattern);
            return match ? { file, number: parseInt(match[1]) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.number - b.number);

    // Determine the next number
    const nextNumber = matchingFiles.length > 0 ? matchingFiles[matchingFiles.length - 1].number + 1 : 0;

    // Copy current file to the new rotated file
    const currentFile = join(__dirname, `${source}.js`);
    const rotatedFile = `${archiveDir}/${source}.js.${nextNumber}`;
    copyFileSync(currentFile, rotatedFile);

    console.log(`Rotated ${currentFile} to ${rotatedFile}`);
}

export const clearCursor = () => {
    process.stdout.write('\x1B[0;0H\x1B[2J');
}
export const cursorUp = '\x1B[A';

export function setConfigFile(f) {
    cfg_file = f;
}

export class Device {
    constructor(deviceCodeFile, cfg = null) {
        this.dCodeFile = deviceCodeFile.endsWith('.js') ? deviceCodeFile.slice(0, -3) : deviceCodeFile;
        setConfigFile(`${this.dCodeFile}.cfg`);
        if (!cfg || !cfg.devId) {
            if (existsSync(cfg_file)) {
                try {
                    cfg = JSON.parse(readFileSync(cfg_file));
                } catch (e) {
                    cfg = {};
                }
            } else {
                cfg = {};
            }
            if(!cfg.devId || !cfg.token || !cfg.broker) {
                console.log('Enter device configuration');
                cfg.devId = getInput('devId: ' + (cfg.devId ||  '?') + ' ') || cfg.devId;
                cfg.token = getInput('token: ' + (cfg.token ||  '?') + ' ') || cfg.token;
                cfg.broker = getInput('broker: ' + (cfg.broker ||  '?') + ' ') || cfg.broker;
                cfg.meta = cfg.meta || {};
                cfg.meta.pubInterval = getInput('pubInterval: ' + (cfg.meta.pubInterval ||  5000) + ' ') || 5000;
                this.saveCfg(cfg);
            }
        } 
        this.caFile = existsSync('ca.pem') ? 'ca.pem' : '';
        this.port = this.caFile ? '8883' : '1883';
        this.proto = this.caFile ? 'mqtts' : 'mqtt';
        this.ssl_params = this.caFile ? { ca: readFileSync(this.caFile) } : {};
        console.log('SSL Params:', this.ssl_params);

        this.broker = cfg.broker || '127.0.0.1';
        this.devId = cfg.devId;
        this.token = cfg.token || null;
        this.meta = cfg.meta || {};

        this.meta['pubInterval'] = this.meta['pubInterval'] || 5000;
        this.cmdCallback = null;
        this.resetCallback = null;
        this.updateCallback = null;
        this.upgradeCallback = null;
        this.isRunning = true;
        
        this.evtTopicBase = `iot3/${this.devId}/evt/`;
        this.cmdTopicBase = `iot3/${this.devId}/cmd/`;
        this.cmdTopic = `${this.cmdTopicBase}+/fmt/+`;
        this.metaTopic = `iot3/${this.devId}/mgmt/device/meta`;
        this.logTopic = `iot3/${this.devId}/mgmt/device/status`;
        this.updateTopic = `iot3/${this.devId}/mgmt/device/update`;
        this.rebootTopic = `iot3/${this.devId}/mgmt/initiate/device/reboot`;
        this.resetTopic = `iot3/${this.devId}/mgmt/initiate/device/factory_reset`;
        this.upgradeTopic = `iot3/${this.devId}/mgmt/initiate/firmware/update`;
        this.connectionTopic = `iot3/${this.devId}/evt/connection/fmt/json`;

        this.run = () => {
            if (!this.isRunning) return;
            this.loop();
            this.timer = setTimeout(this.run, this.meta.pubInterval);
        };

        this.publishChange = () => {
            if (!this.isRunning) return;
            clearTimeout(this.timer);
            this.run();
        };

        this.init = () => {
            // the ?update=Date.now() part makes sure this line always imports the dCodeFile
            import(`./${this.dCodeFile}.js?update=` + Date.now())   
                .then(deviceJS => {
                    if (deviceJS.init && typeof deviceJS.init === 'function') {
                        deviceJS.init(this);
                    } else {
                        console.error('init function not found in the imported module');
                    }
                })
                .catch(err => {
                    console.error('Failed to import module:', err);
                });
        }

        this.init();
    }

    connect() {
        this.client = connect(`${this.proto}://${this.broker}:${this.port}`, {
            clientId: this.devId,
            username: this.devId,
            password: this.token,
            ...this.ssl_params,
            will: {
                topic: this.connectionTopic,
                payload: '{"d":{"status":"offline"}}',
                retain: true, qos: 0
            }
        });

        this.client.on('connect', () => {
            this.client.subscribe(this.cmdTopic);
            this.client.subscribe(this.rebootTopic);
            this.client.subscribe(this.resetTopic);
            this.client.subscribe(this.updateTopic);
            this.client.subscribe(this.upgradeTopic);
            this.client.publish(this.connectionTopic, JSON.stringify({ d: { status: "online" } }), { qos: 0, retain: true });
            this.client.publish(this.metaTopic, JSON.stringify({ d: { metadata: this.meta } }), { qos: 0, retain: true });
        });

        this.client.on('error', (error) => {
            console.error(error);
            process.exit(1);
        });

        this.client.on('message', (topic, msg) => {
            const topicStr = topic.toString();
            if (topicStr === this.rebootTopic) {
                console.log('Rebooting device');
                this.reboot();
            } else if (topicStr === this.resetTopic) {
                if (this.resetCallback) {
                    this.resetCallback(topic, msg);
                } else {
                    console.log('resetting device');
                    this.saveCfg({});
                }
            } else if (topicStr === this.upgradeTopic) {
                let upgradeURL = JSON.parse(msg).d.upgrade.fw_url;
                if (isValidURL(upgradeURL)) {
                    clearTimeout(this.timer);
                    this.isRunning = false;
                    this.client.end();
                    rotateFile(this.dCodeFile);
                    clearCursor();
                    console.log('\nDownloading the firmware');
                    // Download the code
                    const protocol = upgradeURL.startsWith('https:') ? https : http;
                    const fileName = join(__dirname, `${this.dCodeFile}.js`);
                    protocol.get(upgradeURL, (response) => {
                        if (response.statusCode === 200) {
                            const file = writeFile(fileName, '', () => {});
                            response.on('data', (chunk) => {
                                appendFileSync(fileName, chunk);
                            });
                            response.on('end', () => {
                                console.log('Firmware download completed');
                            });
                        } else {
                            console.log(`Download failed with status: ${response.statusCode}`);
                            this.isRunning = true;
                        }
                    }).on('error', (err) => {
                        console.error('Download error:', err);
                    });
                    setTimeout(() => {
                        this.isRunning = true;
                        this.init();
                    }, 1000);
                } else {
                    console.log('Invalid URL for upgrade')
                }
            } else if (topicStr === this.updateTopic) {
                const metafields = JSON.parse(msg).d.fields[0];
                if (metafields.field === 'metadata') {
                    this.meta = metafields.value;
                    this.saveCfg(this.cfg());
                    this.client.publish(this.metaTopic, JSON.stringify({ d: { metadata: this.meta } }), { qos: 0, retain: true });
                }
                if (this.updateCallback) {
                    this.updateCallback(topic, msg);
                }
            } else if (topicStr.startsWith(this.cmdTopicBase) && this.cmdCallback) {
                this.cmdCallback(topic, msg);
            }
        });
    }

    publishEvent(evtId, data, fmt='json', qos=0, retain=false) {
        this.client.publish(`${this.evtTopicBase}${evtId}/fmt/${fmt}`, data, { qos, retain });
    }

    cfg() {
        return {
            broker: this.broker,
            token: this.token,
            devId: this.devId,
            meta: this.meta
        };
    }

    reboot() {
        process.exit(0);
    }

    setUserMeta(callback) {
        this.updateCallback = callback;
    }

    setUpgradeCallback(callback) {
        this.upgradeCallback = callback;
    }

    setUserCommand(callback) {
        this.cmdCallback = callback;
    }

    setResetCallback(callback) {
        if (this.constructor.name === 'Device') {
            this.resetCallback = callback;
        }
    }

    saveCfg(cfg) {
        console.log('Saving configuration', cursorUp)
        writeFile(cfg_file, JSON.stringify(cfg), (err) => {
            if (err) {
                console.error(err);
            }
        });
    }
}

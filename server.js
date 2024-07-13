const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const influx = require('@influxdata/influxdb-client');
const axios = require('axios');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DEBUG = (process.env.DEBUG || 'false') === 'true';
const WEBUI_PORT = parseInt(process.env.WEBUI_PORT || '38901');
const MQTT_CLIENT_ID = process.env.MQTT_CLIENT_ID || 'mqtt2influxdb';
const MQTT_SERVER = process.env.MQTT_SERVER || '127.0.0.1';
const MQTT_PORT = process.env.MQTT_PORT || '1883';
const MQTT_SUB = process.env.MQTT_SUB || 'mqtt2redis/#';
const INFLUXDB_URL = process.env.INFLUXDB_URL || 'http://localhost:8086';
const INFLUXDB_API_TOKEN = process.env.INFLUXDB_API_TOKEN;
const INFLUXDB_ORG = process.env.INFLUXDB_ORG;
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET;
const INFLUXDB_DEFAULT_TAGS = process.env.INFLUXDB_DEFAULT_TAGS || 'clientId:mqtt2influxdb';
const MQTT_INFLUXDB_FIELD_MAP_FILE_URL = process.env.MQTT_INFLUXDB_FIELD_MAP_FILE_URL;
const MQTT_INFLUXDB_VALUES_MAP_FILE_URL = process.env.MQTT_INFLUXDB_VALUES_MAP_FILE_URL;
const FIELD_MAP_FILE = process.env.FIELD_MAP_FILE || 'fieldMap.json';
const VALUES_MAP_FILE = process.env.VALUES_MAP_FILE || 'valuesMap.json';
const ONLY_MATCH_SUFFIXES = (process.env.ONLY_MATCH_SUFFIXES || 'false') === 'true';

let mqttClient;
let influxClient;
let fieldMap = {};
let valuesMap = {};
const cache = {};
const reported = [];

const collectPoint = (topic, data) => {
    if (ONLY_MATCH_SUFFIXES) {
        const field = Object.keys(fieldMap).find(k => topic.endsWith(k));
        if (!field) {
            return;
        }
        const measurementName  = fieldMap[field];
        let value = valuesMap[`${field}:${data}`] ?? data;
        if (typeof data === 'string' && !isNaN(data)) {
            value = parseFloat(data);
        }
        const pnt = new influx.Point(measurementName)
            .tag('topic', topic)
            .floatField('value', value);
        influxClient.writePoint(pnt);
    } else {
        const measurementName  = fieldMap[topic];
        if (!measurementName) {
            if (!reported.includes(topic)) {
                console.log(`Ignorred topic ${topic}!`);
                reported.push(topic);
            }
            return;
        }

        let value = data;
        if (typeof data === 'string' && !isNaN(data)) {
            value = parseFloat(data);
        }
        const pnt = new influx.Point(measurementName)
            .tag('topic', topic)
            .floatField('value', value);
        influxClient.writePoint(pnt);
    }
}

const flatJSON = (jsonData, path) => {
    let res = {};

    Object.keys(jsonData).forEach(k => {
        const x = jsonData[k];
        let p = k;
        if (path !== '') {
            p = `${path}/${k}`;
        }
        if (typeof x === 'object' && !Array.isArray(x) && x !== null) {
            res = {
                ...res,
                ...flatJSON(x, k),
            }
        } else {
            res[p] = x;
        }
    });
    
    return res;
}

const updateCache = (path, data) => {
    const d = path.split('/');
    let c = cache;
    d.forEach((s, i) => {
        if (!c[s]) {
            c[s] = {};
        }
        if (i < d.length-1) {
            c = c[s];
            return;
        }
        c[s] = data;
    });
}

async function loadJsonFileFromUrl(url) {
    try {
        const response = await axios.get(url, {
        responseType: 'json'
        });
        const jsonData = response.data;
        return jsonData;
    } catch (error) {
        console.error(error);
    }
}

const run = async () => {
    let error = false;
    const mqttConfig = {
        clientId: MQTT_CLIENT_ID,
        rejectUnauthorized: false,
        keepalive: 15,
        connectTimeout: 1000,
        reconnectPeriod: 500,
    };

    // Load fieldsMap.json data
    if (fs.existsSync(`./${FIELD_MAP_FILE}`)) {
        fieldMap = require(`./${FIELD_MAP_FILE}`);
    }
    const fieldMapFile = `/mqtt2influxdb/${FIELD_MAP_FILE}`;
    if (fs.existsSync(fieldMapFile)) {
        fieldMap = require(fieldMapFile);
    }
    if (MQTT_INFLUXDB_FIELD_MAP_FILE_URL) {
        loadJsonFileFromUrl(MQTT_INFLUXDB_FIELD_MAP_FILE_URL).then((jsonData) => {
            console.log(`Loaded data from ${MQTT_INFLUXDB_FIELD_MAP_FILE_URL}`);
            fieldMap = jsonData;
        }).catch((error) => {
            console.error(`Error loading data from ${MQTT_INFLUXDB_FIELD_MAP_FILE_URL}: `, error);
        });
    }

    // Load valuesMap.json data
    if (fs.existsSync(`./${VALUES_MAP_FILE}`)) {
        valuesMap = require(`./${VALUES_MAP_FILE}`);
    }
    const valuesMapFile = `/mqtt2influxdb/${VALUES_MAP_FILE}`;
    if (fs.existsSync(valuesMapFile)) {
        valuesMap = require(valuesMapFile);
    }
    if (MQTT_INFLUXDB_VALUES_MAP_FILE_URL) {
        loadJsonFileFromUrl(MQTT_INFLUXDB_VALUES_MAP_FILE_URL).then((jsonData) => {
            console.log(`Loaded data from ${MQTT_INFLUXDB_VALUES_MAP_FILE_URL}`);
            valuesMap = jsonData;
        }).catch((error) => {
            console.error(`Error loading data from ${MQTT_INFLUXDB_VALUES_MAP_FILE_URL}: `, error);
        });
    }

    if (process.env.MQTT_USER) {
        mqttConfig.username = process.env.MQTT_USER;
    }
    if (process.env.MQTT_PASS) {
        mqttConfig.password = process.env.MQTT_PASS;
    }

    if (!INFLUXDB_API_TOKEN) {
        console.error('INFLUXDB_API_TOKEN not defined!');
        error = true;
    }
    if (!INFLUXDB_ORG) {
        console.error('INFLUXDB_ORG not defined!');
        error = true;
    }
    if (!INFLUXDB_BUCKET) {
        console.error('INFLUXDB_BUCKET not defined!');
        error = true;
    }

    if (error) {
        console.log('too many errors, canceling start...');
        return;
    }

    console.log(`Connecting to MQTT server ${MQTT_SERVER}:${MQTT_PORT} ...`);
    mqttClient = mqtt.connect(`mqtt://${MQTT_SERVER}:${MQTT_PORT}`, mqttConfig);

    // mqttClient.on('connect', () => {
    //     console.log('.');
    // });
    
    mqttClient.on('error', (err) => {
        console.log(err);
        process.exit(1);
    });

    mqttClient.on('message', (topic, payload) => {
        const data = payload.toString();

        // ToDO: if data is JSON object like for Tasmota data
        if (data.startsWith('{') && data.endsWith('}')) {
            const jsonData = flatJSON(JSON.parse(data), '');
            Object.keys(jsonData).forEach(k => {
                updateCache(`${topic}/${k}`, jsonData[k]);
                collectPoint(`${topic}/${k}`, jsonData[k]);
            });
        } else {
            updateCache(topic, data);
            collectPoint(topic, data);
        }
    });
    
    while (!mqttClient.connected) {
        await sleep(1000);
    }

    console.log();
    console.log('MQTT server connected...');
    const subs = MQTT_SUB.split('|');
    subs.forEach(sub => {
        console.log(`Subscribing too ${sub}`);
        mqttClient.subscribe(sub);
    });

    console.log(`Connecting to ${INFLUXDB_URL} ...`);
    const influxDB = new influx.InfluxDB({
        url: INFLUXDB_URL,
        token: INFLUXDB_API_TOKEN
    });
    influxClient = influxDB.getWriteApi(
        INFLUXDB_ORG,
        INFLUXDB_BUCKET,
    );

    if (INFLUXDB_DEFAULT_TAGS) {
        const tags = INFLUXDB_DEFAULT_TAGS.split('|');
        const defaultTags = {};
        tags.forEach(tag => {
            const t = tag.split(':');
            defaultTags[t[0]] = t[1];
        });
        influxClient.useDefaultTags(defaultTags);
    }
    console.log('INFLUX connected...');

    console.log(`Setting up express server on port ${WEBUI_PORT}...`);
    const app = express();
    app.use(express.json());
    app.use(cors());

    app.get('/', function (req, res) {
        res.setHeader("Content-Type", "application/json");
        res.status(200);
        res.json(cache);
    });

    app.get('/fieldMap.json', function (req, res) {
        res.setHeader("Content-Type", "application/json");
        res.status(200);
        res.json(fieldMap);
    });

    app.post('/fieldMap.json', function (req, res) {
        // Update fieldMap
        fieldMap = req.body;
        fs.writeFile(fieldMapFile, JSON.stringify(fieldMap), err => {
            if (err) {
                console.error(`Error saving ${FIELD_MAP_FILE} file: `, err);
                res.status(500);
                res.end();
            } else {
                res.status(200);
                res.end();
            }
        });
    });

    app.get('/valuesMap.json', function (req, res) {
        res.setHeader("Content-Type", "application/json");
        res.status(200);
        res.json(valuesMap);
    });

    app.post('/valuesMap.json', function (req, res) {
        // Update valuesMap
        valuesMap = req.body;
        fs.writeFile(valuesMapFile, JSON.stringify(valuesMap), err => {
            if (err) {
                console.error(`Error saving ${VALUES_MAP_FILE} file: `, err);
                res.status(500);
                res.end();
            } else {
                res.status(200);
                res.end();
            }
        });
    });

    app.listen(WEBUI_PORT)
    console.log('Done...');
}

run();

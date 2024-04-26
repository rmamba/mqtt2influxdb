const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const influx = require('@influxdata/influxdb-client');
const axios = require('axios');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DEBUG = (process.env.DEBUG || 'false') === 'true';
const WEBUI_PORT = parseInt(process.env.WEBUI_PORT || '38901');
const MQTT_CLIENT_ID = process.env.MQTT_CLIENT_ID || 'wizLights';
const MQTT_SERVER = process.env.MQTT_SERVER || '127.0.0.1';
const MQTT_PORT = process.env.MQTT_PORT || '1883';
const MQTT_SUB = process.env.MQTT_SUB || 'mqtt2redis/#';
const INFLUXDB_URL = process.env.INFLUXDB_URL || 'http://localhost:8086';
const INFLUXDB_API_TOKEN = process.env.INFLUXDB_API_TOKEN;
const INFLUXDB_ORG = process.env.INFLUXDB_ORG;
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET;
const INFLUXDB_DEFAULT_TAGS = process.env.INFLUXDB_DEFAULT_TAGS || 'clientId:mqtt2influxdb';
const MQTT_INFLUXDB_MAP_FILE_URL = process.env.MQTT_INFLUXDB_MAP_FILE_URL;

let mqttClient;
let influxClient;
let fieldMap = {};
const cache = {};
const reported = [];

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

    if (fs.existsSync('./fieldMap.json')) {
        fieldMap = require('./fieldMap.json');
    }
    const fieldMapFile = '/mqtt2influx/fieldMap.json';
    if (fs.existsSync(fieldMapFile)) {
        fieldMap = require(fieldMapFile);
    }
    if (MQTT_INFLUXDB_MAP_FILE_URL) {
        loadJsonFileFromUrl(MQTT_INFLUXDB_MAP_FILE_URL).then((jsonData) => {
            console.log(`Loaded data from ${MQTT_INFLUXDB_MAP_FILE_URL}`);
            fieldMap = jsonData;
        }).catch((error) => {
            console.error(`Error loading data from ${MQTT_INFLUXDB_MAP_FILE_URL}: `, error);
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
        updateCache(topic, data);

        const measurementName  = fieldMap[topic];
        if (!measurementName) {
            if (!reported.includes(topic)) {
                console.log(`Unknown topic ${topic}!`);
                reported.push(topic);
            }
            return;
        }

        let value = parseFloat(data);
        const pnt = new influx.Point(measurementName)
            .tag('topic', topic)
            .floatField('value', value);
        influxClient.writePoint(pnt);
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
                console.error('Error saving fieldMap.json file: ', err);
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

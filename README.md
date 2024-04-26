# WHAT is mqtt2influxdb?

This container will push data to InfluxDB everytime MQTT data changes.

# MQTT Configuration

You can define MQTT server via env variables like so:
```
MQTT_SERVER=127.0.0.1
MQTT_PORT=1883
MQTT_USER=
MQTT_PASS=
MQTT_SUB=DDS238/#
```
The values listed are default so you can only use the env variable if you want to change it.
`MQTT_SUB` accepts string separated by `|` to listen to multiple paths.

# InfluxDB Configuration

You can define InfluxDB connection via env variables like so:
```
INFLUXDB_URL=http://localhost:8086
INFLUXDB_API_TOKEN=
INFLUXDB_ORG=
INFLUXDB_BUCKET=
INFLUXDB_DEFAULT_TAGS=clientId:mqtt2influxdb
```
The values listed are default so you can only use the env variable if you want to change it.
`INFLUXDB_API_TOKEN` takes a token you generated on your InfluxDB for writing data to the database.
`INFLUXDB_DEFAULT_TAGS` defines the tags that are appended to all the points written into the database
and can be separated by `|` character. For example `clientId:mqtt2influxdb|source:ElectricalGrid|type:electricity`
would tag all your recorded electricity data from electrical grid so you can query and visualize it easily later.


# Docker

Start your container with this command replacing values to match your system:
```
docker run --name mqtt2influxdb -v mqtt2influxdb_config:/mqqt2influxdb -e MQTT_SERVER=192.168.13.37 -e MQTT_USER=user -e MQTT_PASS=password -e INFLUXDB_URL=redis://localhost:8086 -e INFLUXDB_API_TOKEN=1337 -e INFLUXDB_ORG=myOrg -e INFLUXDB_BUCKET=myBucket -e INFLUXDB_DEFAULT_TAGS=clientId:mqtt2influxdb|source:ElectricalGrid|type:electricity -d rmamba/mqtt2influxdb
```
`-v mqtt2influxdb_config:/mqqt2influxdb` creates a storage so `fieldMap.json` file can be saved permanently.

FROM node:18-slim

RUN apt-get update \
    && apt-get install -y openvpn \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY server.js .
COPY package.json .
RUN yarn install

# Set the CMD to your handler (could also be done as a parameter override outside of the Dockerfile)
CMD [ "node", "server.js" ]

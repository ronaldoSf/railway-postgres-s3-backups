ARG NODE_VERSION='20.11.1'

FROM node:${NODE_VERSION}-alpine AS build

WORKDIR /usr/src/api

COPY . .

RUN rm -rf node_modules

RUN npm install

ARG PG_VERSION='17'

RUN echo 'http://dl-cdn.alpinelinux.org/alpine/edge/main' > /etc/apk/repositories

RUN apk add --update --no-cache postgresql${PG_VERSION}-client

CMD npm run start
import 'axios/internal';
import 'gaxios';
import 'got/deep';
import 'ky';
import 'node:http';
import 'node:https';
import 'superagent';
import 'undici';

const fetchAlias = fetch;
void fetchAlias;
void globalThis['fetch'];
void new XMLHttpRequest();
void new WebSocket('wss://invalid.example');
void new EventSource('/events');
void navigator.sendBeacon('/beacon');
void import('axios');

const express = require('express' );
const uuid = require('uuid');
const ping = require('ping');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const Cryptr = require('cryptr');
const npmConfig = require('./package');
const app = express();

const socketClients = {};
const socketSubdomainIds = {};
const socketActivity = {};
const responsesWaiting = {};

const SECRET_KEY = 'TotalSecretKey';


const allowedExt = [
    '.js',
    '.ico',
    '.css',
    '.png',
    '.jpg',
    '.woff2',
    '.woff',
    '.ttf',
    '.svg',
];


const clientRequestHandler = (req, res) => {
    //this should be called only when requested from subdomain
    const domainParts = req.headers.host.split('.');

    if (req.originalUrl.indexOf('.well-known') !== -1){
        // used to verify let's encrypt ssl certs.
        res.statusCode = 200;
        const code = fs.readFileSync('wll.txt', 'utf8');
        res.send(code);
        return;
    }

    if (domainParts.length <= 2) {
        if (allowedExt.filter(ext => req.url.indexOf(ext) > 0).length > 0) {
            const safeSuffix = 'public/' + path.normalize(req.url).replace(/^(\.\.(\/|\\|$))+/, '');
            res.sendFile(path.join(__dirname, safeSuffix));
        } else {
            res.statusCode = 404;
            res.send('404 Not Found');
        }

        return;
    }

    const subdomain = domainParts[0];

    if (typeof socketClients[subdomain] === 'undefined') {
        res.statusCode = 404;
        res.send('404 Not Found');
        return;
    }

    socketActivity[subdomain] = new Date().getTime();

    let body = '';

    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', () => {
        const headersToDelete = [
            'host', 'connection', 'accept-encoding', 'user-agent',
            'referer','sec-fetch-mode','sec-fetch-site', 'origin',
            'sec-fetch-user', 'cookie'
        ];

        const request = {
            id              : subdomain+'-'+uuid.v4(),
            headers         : req.headers,
            deleted_headers : {},
            query           : req.query,
            body            : body,
            path            : req.originalUrl,
            method          : req.method,
            origin          : req.socket.remoteAddress
        };

        for (const headerItem in headersToDelete) {
            request.deleted_headers[headersToDelete[headerItem]] = request.headers[headersToDelete[headerItem]];
            delete request.headers[headersToDelete[headerItem]];
        }

        responsesWaiting[request.id] = {
            time     : new Date().getTime(),
            response : res
        };

        socketClients[subdomain].emit('onRequest', request);
    });
}

const generateRandomString = (length) => {
    let text = "";
    let possible = "abcdefghijklmnopqrstuvwxyz0123456789";

    for (let i = 0; i < length; i++)
        text += possible.charAt(Math.floor(Math.random() * possible.length));

    return text;
};

//handle main point
app.get('/', (req, res) => {
    const domainParts = req.headers.host.split('.');
    if (domainParts.length >= 3 && domainParts[0] !== 'www') {
        clientRequestHandler(req, res);
    }else{
        if (allowedExt.filter(ext => req.url.indexOf(ext) > 0).length > 0) {
            const safeSuffix = 'public/' + path.normalize(req.url).replace(/^(\.\.(\/|\\|$))+/, '');
            res.sendFile(path.join(__dirname, safeSuffix));
        } else {
            res.sendFile(path.join(__dirname,'public/index.html'));
        }
    }
});

//this endpoint is used from electron desktop apps in order to check if there is any update.
app.get('/version-check', (req, res) => {
    if (typeof req.query.v !== 'undefined'){
        try{
            const versionDetails = JSON.parse(fs.readFileSync('version_details.txt', 'utf8'));
            if (versionDetails.version !== req.query.v){
                const result = {
                    hasUpdate : true,
                    updateUrl : versionDetails.updateUrl,
                    newVersion: versionDetails.version
                };
                res.send(result);
            }else{
                res.send({hasUpdate : false});
            }
        }catch (e) {
            res.send({hasUpdate : false});
        }
    }else{
        res.send({hasUpdate : false});
    }
});

/*
    this endpoint checks if the local hook you've chosen is accessible from the internet. This is not a problem that
    MyHook can't handle but the basic idea is to expose local servers and not playing a proxy role.
 */
app.get('/url-check', (req, res) => {
    if (typeof req.query.url === 'undefined'){
        res.send({alive: true});
        return;
    }

    if(req.query.url === 'localhost'){
        res.send({alive: false});
        return;
    }

    const cfg = {
        timeout: 10,
        // WARNING: -i 2 may not work in other platform like window
        extra: ["-i 2"],
    };

    ping.sys.probe(req.query.url , (isAlive) => {
        res.send({alive: isAlive});
    }, cfg);
});

// this endpoint is used to fetch basic stats
app.get('/myhook-stats', (req, res) => {
    const stats = {
        connections         : parseInt(Object.keys(socketClients).length),
        responses_waiting   : parseInt(Object.keys(responsesWaiting).length)
    };
    res.send(stats);
})

app.get('*', clientRequestHandler);
app.post('*', clientRequestHandler);
app.put('*', clientRequestHandler);
app.delete('*', clientRequestHandler);

let serverOptions = {};

// here we store the http/s server instance.
let server = null;

// ssl certs in case you want to encrypt your communication
if (npmConfig.config.useSSL) {
    serverOptions = {
        key: fs.readFileSync(npmConfig.config.sslCerts.key),
        cert: fs.readFileSync(npmConfig.config.sslCerts.cert),
        ca: fs.readFileSync(npmConfig.config.sslCerts.ca)
    };

    //redirect http to https
    http.createServer((req, res) => {
        res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
        res.end();
    }).listen(npmConfig.config.httpPort);
    server = https.createServer(serverOptions, app).listen(443);
}else {
    server = http.createServer(app).listen(npmConfig.config.httpPort);
}

const io = require('socket.io')(server);
io.set('transports', ['websocket']);
console.log('Server started at: '+npmConfig.config.mainDomain+':'+npmConfig.config.httpPort);

io.on('connection', (socket) => {
    let subdomain = null;

    if (typeof socket.handshake.query.ss !== 'undefined'){
        const cryptr = new Cryptr(SECRET_KEY);
        const decryptedSs = cryptr.decrypt(socket.handshake.query.ss);
        const dt = decryptedSs.split(";");

        if (dt.length === 2){
            subdomain = dt[0];
            if (typeof socketClients[subdomain] !== 'undefined') {
                subdomain = null;
            }
        }
    }

    while (subdomain == null) {
        let tempSubdomain = 'test';
        if(!npmConfig.config.useTestSubdomain){
            tempSubdomain = generateRandomString(8);
        }
        if (typeof socketClients[tempSubdomain] === 'undefined') {
            subdomain = tempSubdomain;
        }
    }

    socketClients[subdomain] = socket;
    socketSubdomainIds[socket.id] = subdomain;
    socketActivity[subdomain]= new Date().getTime();
    const subdomainSlug = subdomain;
    subdomain = 'https://'+subdomain+'.' + npmConfig.config.mainDomain + '/';

    const responseHandler = (response) => {
        if (typeof responsesWaiting[response.id] !== 'undefined' ) {
            const waitingResponse = responsesWaiting[response.id].response;

            //default response code is 404 in case the status code from response is not valid
            waitingResponse.statusCode = 404;

            if (typeof response.status !== 'undefined' && parseInt(response.status) > 0){
                waitingResponse.statusCode = response.status;
            }

            const headersToIgnore = ['content-encoding', 'transfer-encoding'];

            for (let headerKey in response.headers ){
                if(headersToIgnore.indexOf(headerKey) !== -1){
                    continue;
                }
                waitingResponse.set(headerKey, response.headers[headerKey]);
            }

            delete responsesWaiting[response.id];

            try {
                if (response.binary_data != null) {
                    waitingResponse.send(response.binary_data);
                }else {
                    waitingResponse.send(response.response_text);
                }
            }catch(e){
                console.log(e);
            }
        }
    };

    socket.on('disconnect', (e,i) => {
        if (typeof socketSubdomainIds[socket.id] !== 'undefined'){
            if (typeof socketClients[socketSubdomainIds[socket.id]] !== 'undefined') {
                const cSock = socketClients[socketSubdomainIds[socket.id]];
                try{
                    delete socketClients[socketSubdomainIds[socket.id]];
                    delete socketSubdomainIds[socket.id];
                    cSock.disconnect();
                }catch (e) {
                    console.log(e);
                }
            }
        }
    });
    socket.on("connect_failed", (e) => {console.log(e)});
    socket.on("connect_error", (e) => {console.log(e)});
    socket.on('onResponse', responseHandler);
    socket.emit('onSubdomainPrepared', subdomain);
    setTimeout(function () {
        const cryptr = new Cryptr(SECRET_KEY);
        const subdomainSs = cryptr.encrypt((subdomainSlug+";"+new Date().getTime()));
        socket.emit('onSsPrepared', subdomainSs);
    },1500);
});


// jobs
// -- response check - if a request is waiting more thant 30 seconds for a response then MyHook will throw 503 error.
const checkPendingRequests = () => {
    for(let requestKey in responsesWaiting){
        const response = responsesWaiting[requestKey].response;
        if (typeof response !== 'undefined'){
            const time = parseInt((new Date().getTime() - response.time)/1000);
            if(time >= 30){
                delete responsesWaiting[response.id];
                response.statusCode = 503;
                response.send('Timeout');
            }
        }
    }
};
console.log('Starting response check job...');
setInterval(checkPendingRequests, 1000);

// -- socket activity check - if the socket has no activity then MyHook server will destroy the connection.
const checkSocketActivity = () => {
    for(let socketKey in socketActivity){
        const lastActivity = parseInt((new Date().getTime() - socketActivity[socketKey])/1000);
        const minutes = parseInt(lastActivity / 60);
        if(minutes >= 1440){
            const socket = socketClients[socketKey];
            socket.disconnect();
            delete socketClients[socketKey];
            delete socketActivity[socketKey];
            console.log('Subdomain and socket suspended: '+socketKey);
        }
    }
};
console.log('Starting socket activity check job...');
setInterval(checkSocketActivity, 60000);

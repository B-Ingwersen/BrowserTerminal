import os
import pty
import sys
import subprocess
import threading
import time
import termios
import struct
import fcntl
import asyncio
import websockets
import json
import flask
import signal
import secrets
import argparse

class Terminal:
    '''Manages a shell session in a psuedo terminal'''

    def __init__(self, sessionID, websocket):
        self.sessionID = sessionID # sessionID
        self.websocket = websocket # current websocket connection
        self.open = False # whether the unerlying shell is open
        self.connected = True # whether the websocket is connected

        self.startTty()

        print(f'Started Session {self.sessionID} (PID={self.subshellPID})')

    def setNewConnection(self, websocket):
        '''reopen a shell session with a new websocket'''

        self.websocket = websocket
        self.connected = True
    
    def startTty(self):
        '''create a new pty and run a start a shell in it'''

        (subshellPID, ttyFd) = pty.fork()
        if subshellPID == pty.CHILD:
            # attempt to use the default shell and home directory
            shell = '/bin/bash'
            if 'SHELL' in os.environ:
                shell = os.environ['SHELL']
            if 'HOME' in os.environ:
                os.chdir(os.environ['HOME'])

            os.execl(shell, ' ')
            os._exit(0)

        # save the shell PID, the pty file descriptor, and mark the session as open
        self.subshellPID = subshellPID
        self.ttyFd = ttyFd
        self.open = True

        # create a thread that sends ttyOutput to the client
        self.outputThread = threading.Thread(target = self.pushTtyOutput)
        self.outputThread.start()

        # create a thread that waits for the shell to exit and cleans up the
        # session
        self.waitThread = threading.Thread(target = self.waitSubshell)
        self.waitThread.start()

    def resizeTerminal(self, row, col):
        '''send a terminal resize event to the pty'''

        windowSizeStruct = struct.pack("HHHH", row, col, 0, 0)
        fcntl.ioctl(self.ttyFd, termios.TIOCSWINSZ, windowSizeStruct)
    
    async def listen(self):
        '''listen to an open connection until the client closes it'''

        print(f'Started connection to session {self.sessionID}')
        connectionDispatcher.pushStateChange()

        self.send(self.sessionID)

        try:
            while self.open:
                message = await self.websocket.recv()
                self.onClientInput(message)

        except websockets.exceptions.ConnectionClosed:
            self.connected = False
        
        connectionDispatcher.pushStateChange()
        print(f'Closed connection to session {self.sessionID}')

    def send(self, data):
        '''send data to the client'''

        coro = self.websocket.send(data)
        asyncio.run_coroutine_threadsafe(coro, loop)

    def waitSubshell(self):
        '''wait for the subshell to close and clean up resources'''

        os.waitpid(self.subshellPID, 0)

        # signal output thread to close
        self.open = False

        # remove from the directory of open shell sessions
        del connectionDispatcher.terminals[self.sessionID]
        connectionDispatcher.pushStateChange()
        print(f'Closed Session {self.sessionID} (PID={self.subshellPID})')

    def pushTtyOutput(self):
        '''send tty output to the client until the shell closes'''

        while self.open:
            try:
                ttyOutput = os.read(self.ttyFd, 1024)
                self.send(ttyOutput.decode('utf-8'))
            except:
                pass
    
    def onClientInput(self, message):
        '''handle messages from the client'''

        if len(message) == 0:
            return

        # keyboard messages (prefix 'k') are sent as input to the pty
        if message[0] == 'k':
            os.write(self.ttyFd, message[1:].encode('utf-8'))

        # resize message (prefix 'r')
        elif message[0] == 'r':
            dimensions = json.loads(message[1:])
            self.resizeTerminal(dimensions['rows'], dimensions['cols'])

class ConnectionDispatcher:
    '''Dispatch web socket requests and manage open connections and terminal
    sessions'''
    
    def __init__(self):
        self.terminals = dict() # mapping of sessionID => Terminal object
        self.accessKeys = dict() # mapping of accessKey => expiration time
        self.managementConnections = set() # set of open management connections

        self.allowedOrigins = [
            "http://localhost:" + str(contentServerPort),
            "https://localhost:" + str(contentServerPort),
            "http://127.0.0.1:" + str(contentServerPort),
            "https://127.0.0.1:" + str(contentServerPort),
        ]

    def generateSessionID(self):
        '''generate a unique new sessionID (8 hex characters)'''

        while True:
            sessionID = secrets.token_hex(4)
            if sessionID not in self.terminals:
                return sessionID

    def generateAccessKey(self):
        '''generate a new access key and set the expiration time 1 hour out'''

        accessKey = secrets.token_hex(1024)
        self.accessKeys[accessKey] = time.time() + 3600

        return accessKey

    def validateAccessKey(self, checkKey):
        '''validate an access key; return True for valid, False for not'''

        # removed expired keys
        currentTime = time.time()
        deleteKeys = set()
        for (key, expire) in self.accessKeys.items():
            if expire < currentTime:
                deleteKeys.add(key)
        for key in deleteKeys:
            del self.accessKeys[key]
        
        # check if the key is still valid; if so accept it and delete it so it
        # cannot be used again
        if checkKey in self.accessKeys:
            del self.accessKeys[checkKey]
            return True
        
        else:
            return False

    async def handler(self, websocket, path):
        '''entry point for connections; authenticate and dispatch them to
        function specific handlers'''
        
        # validate same origin header
        if websocket.request_headers["Origin"] not in self.allowedOrigins:
            await websocket.close()
            return

        # get requested configuration
        configJSON = await websocket.recv()
        try:
            config = json.loads(configJSON)
        except json.JSONDecodeError:
            await websocket.close()
            return
        
        # validate access key
        if 'accessKey' not in config or not self.validateAccessKey(config['accessKey']):
            await websocket.close()
            return

        # dispatch the connection based on the path requested to the function
        # specific handler
        if path == '/term':
            await self.terminalHandler(websocket, config)
        
        elif path == '/manage':
            self.managementConnections.add(websocket)
            await self.managementHandler(websocket, config)
            self.managementConnections.remove(websocket)
        
        else:
            await websocket.close()
            return

    async def terminalHandler(self, websocket, config):
        '''handle a connection requesting a shell session'''
        
        # try to get the sessionID
        if 'sessionID' not in config:
            await websocket.close()
            return
        sessionID = config['sessionID']
        
        # if the sessionID is new, create a new shell session
        if sessionID == 'new':
            sessionID = self.generateSessionID()
            terminal = Terminal(sessionID, websocket)
            self.terminals[sessionID] = terminal
        
        # otherwise attempt to reopen an unconnected session
        elif sessionID in self.terminals and not self.terminals[sessionID].connected:
            terminal = self.terminals[sessionID]
            terminal.setNewConnection(websocket)
            
        else:
            await websocket.close()
            return
        
        # let the terminal session handle the connection until it closes
        await terminal.listen()

    async def managementHandler(self, websocket, config):
        '''setup a terminal management connection'''

        try:
            while True:
                # receive and decode a connection
                message = await websocket.recv()
                try:
                    request = json.loads(message)
                    requestType = request['type']
                except:
                    continue
                
                # send a list of open shell sessions and their state upon a poll
                # request
                if requestType == 'poll':
                    terminals = []
                    for sessionID, terminal in self.terminals.items():
                        if not terminal.open:
                            continue

                        terminals.append({
                            'sessionID' : sessionID,
                            'connected' : terminal.connected
                        })

                    response = json.dumps({'response' : 'poll', 'result' : terminals});

                # attempt to kill a shell session, and report if successful
                elif requestType == 'kill':
                    if 'sessionID' not in request:
                        continue
                    
                    sessionID = request['sessionID']
                    if sessionID in self.terminals and self.terminals[sessionID].open:
                        pid = self.terminals[sessionID].subshellPID
                        os.kill(pid, signal.SIGTERM)
                        response = json.dumps({
                            'response' : 'kill',
                            'result' : 'success',
                            'sessionID' : sessionID
                        })
                    else:
                        response = json.dumps({
                            'response' : 'kill',
                            'result' : 'error',
                            'sessionID' : sessionID,
                            'message' : 'sessionID not found'
                        })

                else:
                    continue

                # send the prepared response to the request
                coro = websocket.send(response)
                asyncio.run_coroutine_threadsafe(coro, loop)

        except websockets.exceptions.ConnectionClosed:
            pass

    def pushStateChange(self):
        '''report the new terminal state (equivalent to a 'poll' response) to
        all management connections'''

        # create the response by serializing the state of all shell sessions
        terminals = []
        for sessionID, terminal in self.terminals.items():
            if not terminal.open:
                continue

            terminals.append({
                'sessionID' : sessionID,
                'connected' : terminal.connected
            })

        response = json.dumps({'response' : 'poll', 'result' : terminals})

        # attempt to send the response to all management connectoins
        for websocket in self.managementConnections.copy():
            try:
                coro = websocket.send(response)
                asyncio.run_coroutine_threadsafe(coro, loop)
            except:
                pass

def runContentServer():
    '''Create a Flask application to serve the terminal and terminal management
    web pages'''

    app = flask.Flask("Terminal Server")

    @app.route('/')
    def loadHTML():
        sessionID = flask.request.args.get('sessionID')
        if sessionID is None:
            sessionID = 'new'

        # set the session variable requested in the GET data and generate a one
        # time acess key
        with open('Terminal.html') as fp:
            source = fp.read()
            source = source.replace('__SESSION_ID__', sessionID)
            source = source.replace('__ACCESS_KEY__', connectionDispatcher.generateAccessKey())
            source = source.replace('__WS_PORT__', str(webSocketPort))
        
        return source
    
    @app.route('/manage')
    def loadManagementPage():
        # generate a one-time access key
        with open('Manage.html') as fp:
            source = fp.read()
            source = source.replace('__ACCESS_KEY__', connectionDispatcher.generateAccessKey())
            source = source.replace('__WS_PORT__', str(webSocketPort))
        
        return source

    @app.route('/Terminal.js')
    def loadJS():
        with open('Terminal.js') as fp:
            source = fp.read()
        return flask.Response(source, mimetype = 'text/javascript')

    @app.route('/Terminal.css')
    def loadCSS():
        with open('Terminal.css') as fp:
            source = fp.read()
        return flask.Response(source, mimetype = 'text/css')

    app.run(host = '127.0.0.1', port = contentServerPort)

parser = argparse.ArgumentParser()

parser.add_argument('-i', '--host', type = str, default = '127.0.0.1',
                    help = "Hostname")
parser.add_argument('-p', '--content-server-port', type = int, default = 9423,
                    help = "Port to run content server on")
parser.add_argument('-w', '--web-socket-port', type = int, default = 7700,
                    help = "Port to run web socket on")  
args = parser.parse_args()
print(args)

hostname = args.host
contentServerPort = args.content_server_port
webSocketPort = args.web_socket_port

# Create the content server and web socket servers and run unkil the program is
# killed by a keyboard interrupt
threading.Thread(target = runContentServer).start()
connectionDispatcher = ConnectionDispatcher()

try:
    server = websockets.serve(connectionDispatcher.handler, hostname, webSocketPort)
    loop = asyncio.get_event_loop()
    loop.run_until_complete(server)
    loop.run_forever()
    
except KeyboardInterrupt:
    print("Exiting program...")
    os._exit(0)
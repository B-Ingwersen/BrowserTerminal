
class Terminal {

    // A terminal emulator that renders inside of a specified DOM node; an
    // application can use it by writing output to the 'processChars' method
    // and setting the 'connection' member with handlers for keyboard output
    // and resize events; the TerminalWSConnection is example connection object
    // that connects to a server with the system shell
    //  div: the DOM node to render in
    //  fontSize: the initial font size
    //  pixWidth: initial width in pixels
    //  pixHeight: initial height in pixels
    //  drawMethod: the rendering mechanism
    //      'DOM'   : (default) construct rows with DOM 'pre' nodes
    //      'canvas': render to an HTML canvas
    constructor(div, fontSize, pixWidth, pixHeight, drawMethod = 'DOM') {

        // the dom element that the terminal should be drawn in
        this.div = div;

        // canvas not actually displayed; used for calculating font dimensions
        this.dimensionCanvas = document.createElement("canvas");

        // what method to use for rendering the terminal
        //  'dom'   : use dom 'pre' nodes
        //  'canvas': use HTML canvas
        this.drawMethod = drawMethod;
        this.rowNodes = []; // array of dom nodes for each line
        this.canvas = document.createElement("canvas");

        // The text and graphical dimensions of the terminal; most of these are
        // placeholder until the redimension call sets their actual dimensions
        this.fontSize = fontSize;       // font size to render in
        this.pixWidth = pixWidth - 10;  // overall terminal size in pixels
        this.pixHeight = pixHeight - 10;
        this.charWidth = 12.0;          // pixel dimensions of a character
        this.charHeight = 20.0;
        this.boldWidthAdjust = 0.0;     // adjustment factors for bold fonts
        this.boldSizeScale = 1.0;
        this.termCols = 80;             // text dimensions of the terminal
        this.termRows = 25;
        this.scrollMin = 0;             // lines in the scrollable region
        this.scrollMax = 24;

        // cursor location (0-based) and current terminal drawing attributes:
        // attr: a bit mask of terminal attributes. Masks are:
        //      0x01 : bold
        //      0x02 : italic
        //      0x04 : underline
        //      0x08 : striekthrough
        // fore, back: hex codes for foreground and background colors
        this.cursor = {
            x: 0,
            y: 0,
            attr: 0,
            fore: "#FFFFFF",
            back: "#000000",
        };

        // internal matrix of characters and color/attributes; the 'output'
        // functions modify this, whereas the draw functions replicate it to the
        // screen; see 'blankRowData' and 'blankCharArray' functions for more
        // information about internal format
        this.charArray = [];

        // dom node that represents the cursor
        this.cursorNode = null;

        // state information for parsing escape sequences
        this.csiBuffer = "";            // buffer for CSI escape sequences
        this.stringEscapeBuf = false;   // buffer for string escape sequences
        
        // character processing function; set to one of the 'cpf' methods;
        // value changes while parseing escape sequences
        this.charProcFunc = this.cpfDefault;

        // RGB values for the default 16 terminal colors
        this.normalColors = [
            "#000000",
            "#D00000",
            "#00C000",
            "#F08000",
            "#0000D0",
            "#A000A0",
            "#10B0B0",
            "#A0A0A0"
        ];
        this.brightColors = [
            "#505050",
            "#FF3030",
            "#20FF20",
            "#FFFF40",
            "#3030FF",
            "#FF20FF",
            "#30FFFF",
            "#FFFFFF"
        ];

        // An object that provides the interface for sending information to
        // whatever program is using the terminal; it must implement
        //  sendKeyboard()
        //  sendResize()
        // See TerminalWSConnection for an example of this
        this.connection = null;

        // initialize graphics and input handling
        this.redimension(fontSize, pixWidth, pixHeight);
        this.attachKeyHandler(this.div);
        this.startAnimation();
    }

    // rebuild the terminal due to a change in the dimensions
    //  fontSize: new font size
    //  width, height: new dimensions in pixels
    redimension(fontSize, width, height) {
        this.fontSize = fontSize;

        // calculate the pixel dimensions of a single character
        var ctx = this.dimensionCanvas.getContext('2d');
        ctx.font = fontSize + "px monospace";
        this.div.style.fontSize = fontSize + "px";
        this.charWidth = ctx.measureText(' ').width;
        this.charHeight = fontSize * 1.2;

        // calculate the adjustment factors for bold font; bold monospace fonts
        // can be wider than normal weight; boldWidthAdjust is the value for the
        // CSS letter-spacing property to correct this; boldSizeScale provides
        // the scale factor for the font size to correct when letter spacing 
        // isn't available (eg canvas rendering)
        ctx.font = "bold " + fontSize + "px monospace";
        this.boldWidthAdjust = this.charWidth - ctx.measureText(' ').width;
        this.boldSizeScale = this.charWidth / ctx.measureText(' ').width;

        // calculate the overall terminal dimensions in pixels and characters
        this.pixWidth = width - 10;
        this.pixHeight = height - 10;
        this.termCols = Math.floor(this.pixWidth / this.charWidth);
        this.termRows = Math.floor(this.pixHeight / this.charHeight);

        // Force a minimum size of 10 rows x 20 cols; this will cause visual
        // overflow if the terminal is made smaller
        if (this.termRows < 10) {
            this.termRows = 10
        }
        if (this.termCols < 20) {
            this.termCols = 20;
        }

        // The upper and lower limits of the scrollable region
        this.scrollMin = 0;
        this.scrollMax = this.termRows - 1;

        // delete all old elements in the terminal DOM node
        while (this.div.firstChild) {
            this.div.removeChild(this.div.firstChild);
        }
        this.rowNodes = [];

        // dimension and create the cursor DOM node
        this.cursorNode = document.createElement("div");
        this.cursorNode.classList = "term-cursor";
        this.div.appendChild(this.cursorNode);
        this.cursorNode.style.width = this.charWidth + "px";
        this.cursorNode.style.height = this.charHeight + "px";

        // fill in the terminal DOM node for the current draw method
        if (this.drawMethod == 'DOM') {

            // build a DOM node for each row in the terminal
            for (var row = 0; row < this.termRows; row++) {
                var rowNode = document.createElement("div");
                rowNode.style.top = row * this.charHeight + "px";
                rowNode.style.width = this.pixWidth + "px";
                rowNode.classList = "term-row";
                this.div.appendChild(rowNode);
                this.rowNodes.push(rowNode);
            }
        }
        else if (this.drawMethod == 'canvas') {
            this.canvas.width = this.pixWidth;
            this.canvas.height = this.pixHeight;
            this.div.appendChild(this.canvas);
        }

        // rebuild the character array and report the size change
        this.blankCharArray();
        this.sendResize(this.termRows, this.termCols);
    }

    // generate a blank line of the character array
    blankRowData() {
        // Each character includes the raw character ('text' field) and the
        // character attributes (same as in Terminal.cursor)
        var rowData = [];
        for (var col = 0; col < this.termCols; col++) {
            rowData.push({
                attr: 0,
                fore: "#FFFFFF",
                back: "#000000",
                text: " "
            });
        }

        return rowData;
    }

    // rebuild the character array according to current terminal dimensions
    blankCharArray() {
        // In each row, the modified field reports whether the line needs to be
        // redrawn in the animation loop, and the row data contains the
        // character information
        var charArray = [];
        for (var row = 0; row < this.termRows; row++) {
            charArray.push({
                modified: true,
                rowData: this.blankRowData()
            });
        }

        this.charArray = charArray;
    }

    // redraw a row (given by rowIndex) for the 'DOM' draw method
    drawRowDOM(rowIndex) {
        var rowData = this.charArray[rowIndex].rowData;
        var rowNode = this.rowNodes[rowIndex];

        // delete what is currenly inside the row's DOM node
        while (rowNode.firstChild) {
            rowNode.removeChild(rowNode.firstChild);
        }

        // add a new chunk to rowNode
        function addNode(term, text, attr, fore, back) {
            if (text.length == 0) {
                return;
            } 

            var node = document.createElement('pre');
            node.classList = 'term-char';
            node.innerText = text;
            node.style.color = fore;
            node.style.backgroundColor = back;
            node.style.width = (term.charWidth * text.length) + 'px';

            var textDecoration = "";
            if (attr & 1) {
                node.style.fontWeight = 'bold';
                node.style.letterSpacing = term.boldWidthAdjust + "px";
            }
            if (attr & 2) {
                node.style.fontStyle = 'italic';
            }
            if (attr & 4) {
                textDecoration += 'underline ';
            }
            if (attr & 8) {
                textDecoration += 'line-through'
            }
            node.style.textDecoration = textDecoration;

            rowNode.appendChild(node);
        }

        // create the row in chunks; identify wherever the color or attribute
        // changes to determine where to create a new chunk
        var lastAttr = null;
        var lastFore = null;
        var lastBack = null;
        var nodeText = "";
        for (var i = 0; i < rowData.length; i++) {
            var charData = rowData[i];

            if (lastAttr != charData.attr
                || lastFore != charData.fore
                || lastBack != charData.back) {
                
                addNode(this, nodeText, lastAttr, lastFore, lastBack);
                nodeText = "";

                lastAttr = charData.attr;
                lastFore = charData.fore;
                lastBack = charData.back;                
            }

            nodeText += charData.text;
        }
        addNode(this, nodeText, lastAttr, lastFore, lastBack);
    }

    // redraw a row (given by rowIndex) for the 'canvas' draw method
    drawRowCanvas(rowIndex) {
        var ctx = this.canvas.getContext('2d');
        var rowData = this.charArray[rowIndex].rowData;
        var term = this;        

        // draw a chunk of the row
        function drawSection(row, col, text, attr, fore, back) {
            var style = '';
            var weight = '';
            var size = term.fontSize;

            if (attr & 1) {
                weight = 'bold ';
                size *= term.boldSizeScale;
            }
            if (attr & 2) {
                style = 'italic ';
            }

            ctx.font = style + weight + size + 'px monospace';
            
            const x = col * term.charWidth;
            const y = row * term.charHeight;

            ctx.fillStyle = back;
            ctx.fillRect(x, y, term.charWidth * text.length, term.charHeight);
            ctx.fillStyle = fore;
            ctx.fillText(text, x, y + term.fontSize);
        }

        // draw the line in chunks, ie sections that have the same colors and
        // attributes
        var lastAttr = null;
        var lastFore = null;
        var lastBack = null;
        var col = 0;
        var text = "";
        for (var i = 0; i < rowData.length; i++) {
            var charData = rowData[i];

            if (lastAttr != charData.attr
                || lastFore != charData.fore
                || lastBack != charData.back) {
                
                drawSection(rowIndex, col, text, lastAttr, lastFore, lastBack);
                text = "";

                lastAttr = charData.attr;
                lastFore = charData.fore;
                lastBack = charData.back;  
                col = i;              
            }

            text += charData.text;
        }

        drawSection(rowIndex, col, text, lastAttr, lastFore, lastBack);
    }

    // redraw the terminal for an animation frame
    draw() {   
        // redraw the row that have been modified using the current drawMethod  
        for (var i = 0; i < this.charArray.length; i++) {
            if (this.charArray[i].modified) {
                this.charArray[i].modified = false;
                if (this.drawMethod == 'DOM') {
                    this.drawRowDOM(i);
                }
                else if (this.drawMethod == 'canvas') {
                    this.drawRowCanvas(i);
                }
            }
        }

        // reposition the cursor node
        this.cursorNode.style.left = this.cursor.x * this.charWidth + "px";
        this.cursorNode.style.top = this.cursor.y * this.charHeight + "px";
    }

    // begin the animation loop that asynchronously redraws the terminal
    startAnimation() {
        var term = this;
        
        var animationFunc = function() {
            term.draw();

            requestAnimationFrame(animationFunc);
        }

        requestAnimationFrame(animationFunc);
    }

    // shift the scrolling region up the specified number of rows, inserting
    // blank rows at the bottom
    outputScrollUp(rows) {
        if (rows > this.termRows) {
            rows = this.termRows;
        }

        for (var i = 0; i < rows; i++) {
            this.charArray.splice(this.scrollMax + 1, 0, {
                modified: true,
                rowData: this.blankRowData()
            });
            this.charArray.splice(this.scrollMin, 1);
        }

        for (var i = 0; i < this.charArray.length; i++) {
            this.charArray[i].modified = true;
        }   
    }

    // shift the scrolling region down the specified number of rows, inserting
    // blank rows at the top
    outputScrollDown(rows) {
        if (rows > this.termRows) {
            rows = this.termRows;
        }

        for (var i = 0; i < rows; i++) {
            this.charArray.splice(this.scrollMin, 0, {
                modified: true,
                rowData: this.blankRowData()
            });
            this.charArray.splice(this.scrollMax + 1, 1);
        }

        for (var i = 0; i < this.charArray.length; i++) {
            this.charArray[i].modified = true;
        }   
    }

    // output character at the current cursor location and color/attributes,
    // moving the cursor and scrolling/wrapping as needed
    outputChars(text) {
        for (var i = 0; i < text.length; i++) {

            // check for cursor overflow and wrap/scroll as needed
            if (this.cursor.x >= this.termCols) {
                this.cursor.y += 1;
                this.cursor.x = 0;

                // scroll if the cursor runs off the end of the scrollable
                // region
                if (this.cursor.y == this.scrollMax + 1) {
                    this.outputScrollUp(1);
                    this.cursor.y = this.scrollMax;
                }
                
                // wrap the cursor if at the end of the screen but outside the
                // scrollable region
                else if (this.cursor.y >= this.termRows) {
                    this.cursor.y = this.termRows - 1;
                }
            }

            // inser the new character
            this.charArray[this.cursor.y].rowData[this.cursor.x] = {
                attr: this.cursor.attr,
                fore: this.cursor.fore,
                back: this.cursor.back,
                text: text[i]
            };

            this.charArray[this.cursor.y].modified = true;
            this.cursor.x += 1;
        }
    }

    // output an 8-character aligned tab
    outputTab() {
        // advance the cursor to the next multiple of 8
        this.cursor.x += 8;
        this.cursor.x &= ~7;

        // go to a new line if this exceeds the terminal width
        if (this.cursor.x > this.termCols) {
            this.cursor.x = 0;
            this.outputLF();
        }
    }

    // output a line feed
    outputLF() {
        this.cursor.y += 1;
        if (this.cursor.y == this.scrollMax + 1) {
            this.outputScrollUp(1);
            this.cursor.y = this.scrollMax;
        }
        else if (this.cursor.y >= this.termRows) {
            this.cursor.y = this.termRows - 1;
        }
    }

    // output a reverse line feed
    outputRLF() {
        this.cursor.y -= 1;
        if (this.cursor.y == this.scrollMin - 1) {
            this.outputScrollDown(1);
            this.cursor.y = this.scrollMin;
        }
        else if (this.cursor.y < 0) {
            this.cursor.y = 0;
        }
    }

    // output a cairrage return
    outputCR() {
        this.cursor.x = 0;
    }

    // process a stream of input data to the terminal, changing the internal
    // state and output as specified
    processChars(chars) {        
        for (let c of chars) {
            this.charProcFunc(c);
        }
    }

    // default character processing function (not handling an escape sequence)
    cpfDefault(c) {
        var hex = c.charCodeAt(0);

        if (hex < 0x20) {
            // check for outputted control character/ look for the start of an
            // escape sequence
            switch (hex) {
                case 0x08:
                    if (this.cursor.x > 0) {
                        this.cursor.x -= 1;
                    }
                    else if (this.cursor.y > 0) {
                        this.cursor.y -= 1;
                        this.cursor.x = this.termCols - 1;
                    }
                    break;
                case 0x09:
                    this.outputTab();
                    break;
                case 0x0A:
                    this.outputLF();
                    break;
                case 0x0D:
                    this.outputCR();
                    break;
                case 0x1B:
                    this.charProcFunc = this.cpfEscape;
                    break;
            }
        }
        else {
            // directly display all other characters
            this.outputChars(c);
        }
    }

    // character processing function for the start of an escape seqence (ESC
    // deteted)
    cpfEscape(c) {
        var hex = c.charCodeAt(0);

        // delegate control to another character processing function depending
        // on the character received
        if (hex >= 0x40 && hex <= 0x5F) { // type Fe escape codes
            switch (hex) {
                case 0x5B: // csi detected
                    this.charProcFunc = this.cpfCSI;
                    break;
                
                case 0x4D: // reverse line feed
                    this.outputRLF();
                    this.charProcFunc = this.cpfDefault;
                    break;

                /* string initiators */
                case 0x50: // device control string
                case 0x5D: // os command
                case 0x58: // start of string
                case 0x5E: // privacy message
                case 0x5F: // application program command
                    this.charProcFunc = this.cpfString;
                    break;
                default:
                    this.charProcFunc = this.cpfDefault;
                    console.log("Unhandled C1 Control Code", hex)
            }
        }
        else if (hex >= 0x20 && hex <= 0x2F) { // any escape code with I bytes
            this.charProcFunc = this.cpfIBytes;
        }
        else { // other escape codes; not parsed of handled
            this.charProcFunc = this.cpfDefault;
            console.log("Unhandled Escape Code", hex)
        }
    }

    // character processing function for escape sequences with I bytes; these
    // are simply parsed and not handled
    cpfIBytes(c) {
        var hex = c.charCodeAt(0);
        if (hex < 0x20 || hex > 0x2F) {
            this.charProcFunc = this.cpfDefault;
        }
    }

    // character processing function for string escape codes; this just parses
    // to the string terminator sequence and does not actually handle them
    cpfString(c) {
        if (c == '\x1B') {
            this.stringEscapeBuf = true;
        }
        else {
            if ((this.stringEscapeBuf && c == '\\') || c == '\x07') {
                this.charProcFunc = this.cpfDefault;
            }
            this.stringEscapeBuf = false;
        }
    }

    // peform generic parsing of the body of CSI control sequences: returns a
    // list of semi-colon separated numbers; a zero is inserted in empty
    // sequences; if a non-semicolon or digit is encountered, returns an empty
    // array
    parseCSIBuffer() {
        var entries = [];
        var currentEntry = "";
        for (let c of this.csiBuffer) {
            if (c == ';') {
                if (currentEntry.length == 0) {
                    entries.push(0);
                }
                entries.push(Number(currentEntry));
                currentEntry = "";
            }
            else if (c.charCodeAt(0) <= 0x39) {
                currentEntry += c;
            }
            else {
                return [];
            }
        }

        if (currentEntry.length != 0) {
            entries.push(Number(currentEntry));
        }
        else {
            entries.push(0);
        }

        return entries;
    }

    // character processing function for CSI escape sequences
    cpfCSI(c) {
        var hex = c.charCodeAt(0);

        // accumulate non-terminating sequences in the csiBuffer, and handle
        // the sequence when the terminating character is encountered
        if (hex >= 0x30 && hex <= 0x3F) {
            this.csiBuffer += c;
        }
        else {
            var args = this.parseCSIBuffer();
            var csiBuffer = this.csiBuffer;
            this.charProcFunc = this.cpfDefault;
            this.csiBuffer = "";

            if (args.length == 0) {
                console.log('Un-parsed CSI', hex, csiBuffer);
            }

            // handle recognized CSI sequences
            switch (hex) {
                case 0x40: // insert blank characters
                    var nChars = 0;
                    if (args.length > 1) {
                        break;
                    }
                    else if (args.length == 1) {
                        nChars = args[0];
                    }

                    if (nChars < 1) {
                        nChars = 1;
                    }
                    if (nChars > this.termCols - this.cursor.x) {
                        nChars = this.termCols - this.cursor.x;
                    }

                    for (var i = 0; i < nChars; i++) {
                        this.charArray[this.cursor.y].rowData.splice(this.cursor.x, 0, {
                            attr: 0,
                            fore: "#FFFFFF",
                            back: "#000000",
                            text: " "
                        });
                        this.charArray[this.cursor.y].rowData.pop();
                    }

                    break;
                case 0x46: // cursor previous line
                    if (args.length > 1) {
                        break;
                    }
                    this.cursor.x = 0;
                case 0x41: // cursor up
                    var dist = 0;
                    if (args.length > 1) {
                        break;
                    }
                    else if (args.length == 1) {
                        dist = args[0];
                        if (dist < 1) {
                            dist = 1;
                        }
                    }

                    if (dist > this.cursor.y) {
                        this.cursor.y = 0;
                    }
                    else {
                        this.cursor.y -= dist;
                    }

                    break;
                case 0x45: // cursor next line
                    if (args.length > 1) {
                        break;
                    }
                    this.cursor.x = 0;
                case 0x42: // cursor down
                    var dist = 0;
                    if (args.length > 1) {
                        break;
                    }
                    else if (args.length == 1) {
                        dist = args[0];
                        if (dist < 1) {
                            dist = 1;
                        }
                    }

                    if (dist > this.termRows - this.cursor.y - 1) {
                        this.cursor.y = this.termRows - 1;
                    }
                    else {
                        this.cursor.y += dist;
                    }

                    break;
                case 0x43: // cursor forward
                    var dist = 0;
                    if (args.length > 1) {
                        break;
                    }
                    else if (args.length == 1) {
                        dist = args[0];
                        if (dist < 1) {
                            dist = 1;
                        }
                    }

                    if (dist > this.termCols - this.cursor.x - 1) {
                        this.cursor.x = this.termCols - 1;
                    }
                    else {
                        this.cursor.x += dist;
                    }

                    break;
                case 0x44: // cursor back
                    var dist = 0;
                    if (args.length > 1) {
                        break;
                    }
                    else if (args.length == 1) {
                        dist = args[0];
                        if (dist < 1) {
                            dist = 1;
                        }
                    }

                    if (dist > this.cursor.x) {
                        this.cursor.x = 0;
                    }
                    else {
                        this.cursor.x -= dist;
                    }

                    break;
                case 0x47: // cursor horizontal absolute
                    var col = 0;
                    if (args.length > 1) {
                        break;
                    }
                    else if (args.length == 1) {
                        col = args[0] - 1;
                    }

                    if (col < 0) {
                        col = 0;
                    }
                    if (col > this.termCols) {
                        col = this.termCols;
                    }
                    this.cursor.x = col;

                    break;
                case 0x66: // horizontal vertical position
                case 0x48: // cursor position
                    var row = 0;
                    var col = 0;
                    if (args.length > 2) {
                        break;
                    }
                    else if (args.length == 1) {
                        row = args[0] - 1;
                    }
                    else if (args.length == 2) {
                        row = args[0] - 1;
                        col = args[1] - 1;
                    }

                    if (row < 0) {
                        row = 0;
                    }
                    if (col < 0) {
                        col = 0;
                    }
                    if (row >= this.termRows) {
                        row = this.termRows - 1;
                    }
                    if (col > this.termCols) {
                        col = this.termCols;
                    }

                    this.cursor.y = row;
                    this.cursor.x = col;

                    break;
                case 0x4A: // erase in display
                    var operation = 0;
                    if (args.length > 1) {
                        break;
                    }
                    else if (args.length == 1) {
                        operation = args[0];
                    }

                    var startX = 0;
                    var startY = 0;
                    var endX = 0;
                    var endY = this.termRows;
                    if (operation == 0) { // clear to end of screen
                        startX = this.cursor.x;
                        startY = this.cursor.y;
                    }
                    else if (operation == 1) { // clear *through* cursor
                        endX = this.cursor.x + 1;
                        if (endX > this.termCols) {
                            endX = this.termCols;
                        }
                        endY = this.cursor.y;
                    }
                    else if (operation == 3) {
                        // potential TODO -- clear scrollback buffer
                    }
                    else if (operation != 2) { // invalid operation
                        return;
                    }

                    var x = startX;
                    var y = startY;
                    while (true) {
                        if (x == this.termCols) {
                            x = 0;
                            y += 1;
                        }

                        if (x == endX && y == endY) {
                            break;
                        }

                        this.charArray[y].rowData[x] = {
                            attr: 0,
                            fore: "#FFFFFF",
                            back: "#000000",
                            text: " "
                        };

                        x += 1;
                    }

                    if (endY == this.termCols) {
                        endY -= 1;
                    }
                    for (var y = startY; y < endY; y++) {
                        this.charArray[y].modified = true;
                    }

                    break;
                case 0x4B: // erase in line
                    var operation = 0;
                    if (args.length > 1) {
                        break;
                    }
                    else if (args.length == 1) {
                        operation = args[0];
                    }

                    var startX = 0;
                    var endX = this.termCols;
                    if (operation == 0) {
                        startX = this.cursor.x;
                    }
                    else if (operation == 1) { // clear *through* cursor
                        endX = this.cursor.x + 1;
                        if (endX > this.termCols) {
                            endX = this.termCols;
                        }
                    }
                    else if (operation != 2) {
                        break;
                    }

                    for (var x = startX; x < endX; x++) {
                        this.charArray[this.cursor.y].rowData[x] = {
                            attr: 0,
                            fore: "#FFFFFF",
                            back: "#000000",
                            text: " "
                        };
                    }
                    this.charArray[this.cursor.y].modified = true;

                    break;
                case 0x4C: // insert lines
                    var lines = 1;
                    if (args.length == 1) {
                        lines = args[0];
                    }
                    else if (args.length > 1) {
                        break;
                    }

                    if (lines <= 0) {
                        lines = 1;
                    }
                    if (lines > this.termRows) {
                        lines = this.termRows;
                    }

                    for (var i = 0; i < lines; i++) {
                        this.charArray.splice(this.cursor.y, 0, {
                            modified: true,
                            rowData: this.blankRowData()
                        });
                        this.charArray.splice(this.scrollMax + 1, 1);
                    }
                    for (var i = 0; i < this.charArray.length; i++) {
                        this.charArray[i].modified = true;
                    }

                    break;
                case 0x50: // delete character
                    var chars = 1;
                    if (args.length == 1) {
                        chars = args[0];
                    }
                    else if (args.length > 1) {
                        break;
                    }

                    if (chars < 1) {
                        chars = 1;
                    }
                    if (chars > this.termCols - this.cursor.x) {
                        chars = this.termCols - this.cursor.x;
                    }

                    for (var i = 0; i < chars; i++) {
                        this.charArray[this.cursor.y].rowData.push({
                            attr: 0,
                            fore: "#FFFFFF",
                            back: "#000000",
                            text: " "
                        });
                        this.charArray[this.cursor.y].rowData.splice(this.cursor.x, 1);
                    }
                    this.charArray[this.cursor.y].modified = true;
                    
                    break;
                case 0x53: // scroll up
                    var rows = 0;
                    if (args.length > 1) {
                        break;
                    }
                    if (args.length == 1) {
                        rows = args[0];
                        if (rows < 0) {
                            rows = 0;
                        }
                    }
                    
                    this.outputScrollUp(rows);
                    break;
                case 0x54: // scroll down
                    var rows = 0;
                    if (args.length > 1) {
                        break;
                    }
                    if (args.length == 1) {
                        rows = args[0];
                        if (rows < 0) {
                            rows = 0;
                        }
                    }
                    
                    this.outputScrollDown(rows);
                    break;
                case 0x58: // erase character
                    var chars = 1;
                    if (args.length == 1) {
                        chars = args[0];
                    }
                    else if (args.length > 1) {
                        break;
                    }

                    if (chars < 1) {
                        chars = 1;
                    }

                    var x = terminal.cursor.x;
                    var y = terminal.cursor.y;
                    for (var i = 0; i < chars; i++) {
                        if (x == this.termCols) {
                            x = 0;
                            y += 1;
                            if (y >= this.termRows) {
                                break;
                            }
                        }

                        this.charArray[y].rowData[x] = {
                            attr: 0,
                            fore: "#FFFFFF",
                            back: "#000000",
                            text: " "
                        };
                        this.charArray[y].modified = true;

                        x += 1;
                    }

                    break;
                case 0x63:
                    if (csiBuffer.length > 1 && csiBuffer[0] == '>') {
                        this.sendKeyboard('\x1b[0;0;0c');
                    }
                    else if (csiBuffer.length > 1 && csiBuffer[0] == '=') {
                        // terminal unit id -- not implemented
                    }
                    else {
                        this.sendKeyboard('\x1b[?1;2c')
                    }

                    break;
                case 0x64: // set cursor vertical position
                    var row = 0;
                    if (args.length > 1) {
                        break;
                    }
                    else if (args.length == 1) {
                        row = args[0] - 1;
                    }

                    if (row < 0) {
                        row = 0;
                    }
                    if (row >= this.termRows) {
                        row = this.termRows - 1;
                    }

                    this.cursor.y = row;
                    break;
                case 0x6D: // select graphic rendition
                    this.processSGR(args);
                    break;
                case 0x6E: // device status report if val = 6
                    if (args.length == 1 && args[0] == 6) {
                        this.sendKeyboard("\x1b[" + (this.cursor.y + 1) + ";"
                            + (this.cursor.x + 1) + "R");
                    }
                    break;
                case 0x72: // set scrolling region
                    var top = 0;
                    var bottom = this.termRows - 1;
                    if (args.length == 2) {
                        top = args[0] - 1;
                        bottom = args[1] - 1;
                    }
                    else if (args.length == 1) {
                        top = args[0];
                    }
                    else if (args.length > 2) {
                        break;
                    }

                    if (top < 0) {
                        top = 0;
                    }
                    if (bottom >= this.termRows) {
                        bottom = this.termRows - 1;
                    }
                    if (top >= bottom - 1) {
                        break;
                    }

                    this.scrollMin = top;
                    this.scrollMax = bottom;
                    this.cursor.x = 0;
                    this.cursor.y = 0;
                    
                    break;
                default:
                    console.log('Call to unimplemented CSI', hex, csiBuffer);
            }
        }
    }

    // process a Select Graphics Rendition CSI (CSI's ending in 'm')
    processSGR(args) {

        // take the first argument, process it, and repeat to handle multiple
        // SGR commands bundled into the same escape sequences
        while (args.length > 0) {
            var arg = args.shift();
            
            // handle setting the foreground or background color from the basic
            // 16 color pallete
            if (arg >= 30 && arg <= 37) {
                this.cursor.fore = this.normalColors[arg - 30];
                continue;
            }
            else if (arg >= 40 && arg <= 47) {
                this.cursor.back = this.normalColors[arg - 40];
                continue;
            }
            if (arg >= 90 && arg <= 97) {
                this.cursor.fore = this.brightColors[arg - 90];
                continue;
            }
            else if (arg >= 100 && arg <= 107) {
                this.cursor.back = this.brightColors[arg - 100];
                continue;
            }

            // handle other implemented SGR commands
            switch (arg) {
                case 0: // reset/normal
                    this.cursor.attr = 0;
                    this.cursor.fore = "#FFFFFF";
                    this.cursor.back = "#000000";
                    break
                case 1: // bold
                    this.cursor.attr |= 1;
                    break;
                case 2: // faint
                    // TODO
                    break;
                case 3: // italic
                    this.cursor.attr |= 2;
                    break;
                case 4: // unerline
                    this.cursor.attr |= 4;
                    break;
                case 5: // slow blink
                    // TODO
                    break;
                /* case 6: rapid blink -- UNSUPPORTED */
                case 7: // swap foreground and background colors
                case 27: // reverse off
                    var oldFore = this.cursor.fore;
                    this.cursor.fore = this.cursor.back;
                    this.cursor.back = oldFore;
                    break;
                /* case 8: hide -- UNSUPPORTED */
                case 9: // crossed out
                    this.cursor.attr |= 8;
                    break;
                /* cases 10-19: alternative fonts -- UNSUPPORTED */
                /* case 20: Fraktur -- UNSUPPORTED */
                case 21: // bold-off
                    this.cursor.attr &= ~1;
                    break;
                case 22: // normal color intensity
                    this.cursor.attr &= ~1;
                    // TODO -- faint off
                    break;
                case 23: // italic off
                    this.cursor.attr &= ~2;
                    break;
                case 24: // underline off
                    this.cursor.attr &= ~4;
                    break;
                case 25: // blink off
                    // TODO
                    break;
                /* case 26: Proportional spacing -- UNSUPPORTED */
                /* case 28: hide off -- UNSUPPORTED */
                case 29: // crossed out off
                    this.cursor.attr &= ~8;
                    break;
                case 38: // set foreground color
                    var color = this.processSGRColor(args);
                    if (color) {
                        this.cursor.fore = color;
                    }

                    break;
                case 39: // default foreground color
                    this.cursor.fore = "#FFFFFF";
                    break;
                case 48: // set background color
                    var color = this.processSGRColor(args);
                    if (color) {
                        this.cursor.back = color;
                    }

                    break;
                case 49: // default background color
                    this.cursor.back = "#000000";
                    break;
                /* cases 50 - 74: (frame, encircle, overline, underline color,
                    ideogram, superscript/subscript) -- UNSUPPORTED: */
            }
        }
    }

    // calculate the hex RGB string for 256 color or 24-bit color SGR encodings;
    // return null if the arguments are invalid
    processSGRColor(args) {
        if (args.length < 1) {
            return null;
        }

        // convert rgb values to a hex color string
        const rgbToHex = function(r, g, b) {
            var rStr = r.toString(16);
            var gStr = g.toString(16);
            var bStr = b.toString(16);
            rStr = rStr.length == 1 ? "0" + rStr : rStr;
            gStr = gStr.length == 1 ? "0" + gStr : gStr;
            bStr = bStr.length == 1 ? "0" + bStr : bStr;

            return "#" + rStr + gStr + bStr;
        };

        var type = args.shift();
        if (type == 5) { // 256-color mode
            if (args.length == 0) {
                return null;
            }

            var color = args.shift();

            if (color < 0) {
                color = 0;
            }
            else if (color > 255) {
                color = 255;
            }

            if (color < 8) { // basic normal color
                return this.normalColors[color];
            }
            else if (color < 16) { // basic bright color
                return this.brightColors[color - 8];
            }
            else if (color < 232) { // color from the 16x16x16 color cube
                color -= 16;
                var b = 51 * (color % 6);
                var g = 51 * (Math.floor(color / 6) % 6);
                var r = 51 * (Math.floor(color / 36) % 6);
                return rgbToHex(r,g,b)
            }
            else { // grayscale gradient
                var r = 8 + 10 * (color - 232);
                var g = r;
                var b = r;
                return rgbToHex(r,g,b)
            }
        }
        else if (type == 2) { // 24-bit RGB color
            if (args.length < 3) {
                return null;
            }

            var r = args.shift();
            var g = args.shift();
            var b = args.shift();

            if (r > 255) {
                r = 255;
            }
            else if (r < 0) {
                r = 0;
            }
            if (g > 255) {
                g = 255;
            }
            else if (g < 0) {
                g = 0;
            }
            if (b > 255) {
                b = 255;
            }
            else if (b < 0) {
                b = 0;
            }

            return rgbToHex(r,g,b);
        }
        else {
            return null;
        }
    }

    // send keyboard bytes to the application (if a connection has been set up)
    sendKeyboard(data) {
        if (this.connection) {
            this.connection.sendKeyboard(data);
        }
    }

    // send a resize event to the application (if a connection has been set up)
    sendResize(rows, cols) {
        if (this.connection) {
            this.connection.sendResize(rows, cols);
        }
    }

    // add a keyboard event listener to a dom element that will feed input to
    // the terminal
    attachKeyHandler(domElement) {
        var term = this;

        // character encodings for special characters (when no modifying 
        // characters are pressed)
        const normalKeyMap = {
            Backspace : "\x7f",
            Delete : "\x1b[3~",
            Escape : "\x1b",
            Tab : "\t",
            Enter : "\r",
            ArrowUp : "\x1b[A",
            ArrowDown : "\x1b[B",
            ArrowRight : "\x1b[C",
            ArrowLeft : "\x1b[D",
            PageUp : "\x1b[5~",
            PageDown : "\x1b[6~",
            Home : "\x1b[H",
            End : "\x1b[F",
            Insert : "\x1b[2~",
            F1 : "\x1bOP",
            F2 : "\x1bOQ",
            F3 : "\x1bOR",
            F4 : "\x1bOS",
            F5 : "\x1b[15~",
            F6 : "\x1b[17~",
            F7 : "\x1b[18~",
            F8 : "\x1b[19~",
            F9 : "\x1b[20~",
            F10 : "\x1b[21~",
            F11 : "\x1b[23~",
            F12 : "\x1b[24~",
        };

        const handlerFunction = function(event) {
            event.preventDefault();
            var seq = "";

            if (event.key.length == 1 && !event.ctrlKey && !event.altKey) {
                // use the event key for non-special characters without modifier
                // keys
                seq = event.key;
            }
            else if (!event.ctrlKey && !event.altKey && !event.shiftKey) {
                // use the normal key map for special characters when no
                // modifier characters are down
                if (normalKeyMap[event.key]) {
                    seq = normalKeyMap[event.key];
                }
            }
            else if (event.ctrlKey && !event.altKey) {
                if (event.key == '=') { // Zoom in handler
                    term.redimension(
                        terminal.fontSize * 1.2,
                        terminal.pixWidth + 10,
                        terminal.pixHeight + 10
                    );
                    return;
                }
                else if (event.key == '-') { // Zoom out handler
                    term.redimension(
                        terminal.fontSize / 1.2,
                        terminal.pixWidth + 10,
                        terminal.pixHeight + 10,
                    );
                    return;
                }
                else if (event.key == 'r' && event.ctrlKey) {
                    // get rid of this if you want ctrl-r functionality
                    // ctrl-shift-r still works
                }
                else if (event.key.length == 1) { // basic ASCII control codes
                    var ascii = event.key.charCodeAt(0);

                    if (ascii >= 0x40 && ascii <= 0x5F) {
                        seq = String.fromCharCode(ascii - 0x40);
                    }
                    else if (ascii >= 0x61 && ascii <= 0x7A) {
                        seq = String.fromCharCode(ascii - 0x60);
                    }
                }
            }
        
            terminal.sendKeyboard(seq);
        }

        domElement.addEventListener('keydown', handlerFunction, true);
    }

    // focus the keyboard on the terminal's dom element
    focus() {
        this.div.focus();
    }
}

class TerminalWSConnection {
    
    // Web Socket connection manager form the TerminalServer.py server to a 
    // Terminal object
    //  terminal        : Terminal object to receive tty output and forward
    //                      keyboard/resize events from
    //  webSocketURL    : address of the server to connect to
    //  accessKey       : optional access key for server authentication
    //  sessionID       : sessionID to resume or 'new' to request a new session
    constructor(terminal, webSocketUrl, accessKey, sessionID) {
        this.terminal = terminal;
        this.accessKey = accessKey;
        this.sessionID = sessionID;
        this.webSocket = new WebSocket(webSocketUrl);

        // The current connection state:
        //  'setup' : waiting for sessionID from server
        //  'open'  : receiving terminal input; should be passed to terminal
        //  'error' : setup/connection error; data not forwarded
        //  'closed': connection with server lost; data not forwaded
        this.connectionState = "setup";

        // redirect websocket events to the TerminalWSConnection object
        var connection = this;
        this.webSocket.onopen = (evt) => {
            connection.onopen(evt);
        };
        this.webSocket.onmessage = (evt) => {
            connection.onmessage(evt);
        };
        this.webSocket.onclose = (evt) => {
            connection.onclose(evt);
        };

        // set as terminal connection object so keyboard/resize events will
        // be forwarded and sent through the web socket
        this.terminal.connection = connection;
    }

    // send the server the access credentials and session to initiate protocol
    onopen(evt) {
        this.webSocket.send(JSON.stringify({
            accessKey: this.accessKey,
            sessionID: this.sessionID
        }));
    }

    // server message handler
    onmessage(evt) {
        // get the assigned sessionID from the server, and move into the open
        // state if successful
        if (this.connectionState == "setup") {
            var sessionID = evt.data;

            if (sessionID == 'error') {
                this.connectionState = 'error';
            }
            else {
                this.sessionID = sessionID;

                this.sendResize(this.terminal.termRows - 1,
                    this.terminal.termCols - 1);
                this.sendResize(this.terminal.termRows, this.terminal.termCols);

                this.connectionState = 'open'
            }
        }
        // standard data forwarding to terminal when in 'open' state
        else if (this.connectionState == "open") {
            this.terminal.processChars(evt.data)
        }
    }

    // connection loss handler
    onclose(evt) {
        this.connectionState = 'closed';
        console.log('Terminal WS connection closed, session =', this.sessionID);
    }

    // send a resize event to the server
    sendResize(rows, cols) {
        this.webSocket.send('r' + JSON.stringify({
            rows: rows,
            cols: cols
        }));
    }

    // send a keyboard event to the server
    sendKeyboard(data) {
        this.webSocket.send('k' + data);
    }
}

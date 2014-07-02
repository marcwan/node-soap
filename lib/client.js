/*
 * Copyright (c) 2011 Vinay Pulim <vinay@milewise.com>
 * MIT Licensed
 */
 
function findKey(obj, val) {
    for (var n in obj) if (obj[n] === val) return n;
}

var http = require('./http'),
    assert = require('assert'),
    url = require('url');

var Client = function(wsdl, endpoint) {
    this.wsdl = wsdl;
    this._initializeServices(endpoint);
}

Client.prototype.debug_info = null;

Client.prototype.addEnvelopeNamespace = function () {
    var nses;
    if (arguments.length == 1) {
        nses = arguments[0];
    } else if (arguments.length == 2) {
        nses = { };
        nses[arguments[0]] = arguments[1];
    } else {
        throw new Error("Invalid argument list.");
    }

    for (xmlns in nses) {
        var url = nses[xmlns];
        var found = false;

        if (!this.user_xmlns) this.user_xmlns = { };
        for (var ns in this.user_xmlns) {
            if (xmlns == ns) {
                // already got it. check it's the same.
                if (url != this.user_xmlns[ns])
                    throw new Error("URLS for ns: " + ns + " (" 
                                    + this.user_xmlns[xmlns] + " and "
                                    + url + ") don't match");
                found = true;
                break;
            }
        }

        if (!found)
            this.user_xmlns[xmlns] = url;
    }
}

Client.prototype.addExtraHeaders = function () {
    var h;
    if (arguments.length == 2) {
        // should be two strings.
        h = { };
        h[arguments[0]] = arguments[1];
    } else if (Array.isArray(arguments[0])) {
        h = arguments[0];
    }

    if (!h || typeof h != 'object' || Object.keys(h).length == 0)
        return;

    // great, now go!
    if (!this.user_headers) this.user_headers = [];

    for (var key in h) {
        this.user_headers[key] = h[key];
    }
};



Client.prototype.addSoapHeader = function(soapHeader, name, namespace, xmlns) {
	if(!this.soapHeaders){
		this.soapHeaders = [];
	}
	if(typeof soapHeader == 'object'){
		soapHeader = this.wsdl.objectToXML(soapHeader, name, namespace, xmlns);
	}
	this.soapHeaders.push(soapHeader);
}

Client.prototype.setEndpoint = function(endpoint) {
    this.endpoint = endpoint;
    this._initializeServices(endpoint);
}

Client.prototype.describe = function() {
    var types = this.wsdl.definitions.types;
    return this.wsdl.describeServices();
}

Client.prototype.setSecurity = function(security) {
    this.security = security;
}

Client.prototype.setSOAPAction = function(SOAPAction) {
    this.SOAPAction = SOAPAction;
}

Client.prototype._initializeServices = function(endpoint) {
    var definitions = this.wsdl.definitions,
        services = definitions.services;
    for (var name in services) {
        this[name] = this._defineService(services[name], endpoint);
    }
}

Client.prototype._defineService = function(service, endpoint) {
    var ports = service.ports,
        def = {};
    for (var name in ports) {
        def[name] = this._definePort(ports[name], endpoint ? endpoint : ports[name].location);
    }
    return def;
}

Client.prototype._definePort = function(port, endpoint) {
    var location = endpoint,
        binding = port.binding,
        methods = binding.methods,
        def = {};
    for (var name in methods) {
        def[name] = this._defineMethod(methods[name], location);
        if (!this[name]) this[name] = def[name];
    }
    return def;
}

Client.prototype._defineMethod = function(method, location) {
    var self = this;
    return function(args, callback) {
        if (typeof args === 'function') {
            callback = args;
            args = {};
        }
        self._invoke(method, args, location, function(error, result, raw) {
            callback(error, result, raw);
        })
    }
}


Client.prototype._envelopeNamespaces = function () {
    var out = '';
    if (this.user_xmlns && typeof this.user_xmlns == 'object') {
        for (var ns in this.user_xmlns) {
            out += ' xmlns:' + ns + "=\"" + this.user_xmlns[ns] + "\"";
        }
        if (this.user_xmlns["targetNamespace"])
            out += " xmlns=\"" + this.user_xmlns["targetNamespace"] + "\"";
    }

    return out;
}


Client.prototype._mergeHeaders = function (out, user) {
    var h;
    if (out)
        h = JSON.parse(JSON.stringify(out));
    else
        h = { };
    for (key in user) {
        h[key] = user[key];
    }
    return h;
};


Client.prototype._invoke = function(method, arguments, location, callback) {
    var self = this,
        name = method.$name,
        input = method.input,
        output = method.output,
        style = method.style,
        defs = this.wsdl.definitions,
        ns = defs.$targetNamespace,
        encoding = '',
        message = '',
        xml = null,
        soapAction = this.SOAPAction ? this.SOAPAction(ns, name) : (method.soapAction || (((ns.lastIndexOf("/") != ns.length - 1) ? ns + "/" : ns) + name)),
        headers = {
            SOAPAction: '"' + soapAction + '"',
            'Content-Type': "text/xml; charset=utf-8"
        },
        options = {},
        alias = findKey(defs.xmlns, ns);
    
    // Allow the security object to add headers
    if (self.security && self.security.addHeaders)
        self.security.addHeaders(headers);
    if (self.security && self.security.addOptions)
        self.security.addOptions(options);

    headers = this._mergeHeaders(headers, this.user_headers);

        
    if (input.parts) {
        assert.ok(!style || style == 'rpc', 'invalid message definition for document style binding');
        message = self.wsdl.objectToRpcXML(name, arguments, alias, ns);
        (method.inputSoap === 'encoded') && (encoding = 'soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" ');
    }
    else if (typeof(arguments) === 'string') {
      message = arguments;
    }
    else {
        assert.ok(!style || style == 'document', 'invalid message definition for rpc style binding');
        message = self.wsdl.objectToDocumentXML(input.$name, arguments, input.targetNSAlias, input.targetNamespace);
    }
    xml = "<soap:Envelope " + 
            "xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\" " +
            encoding +
            this._envelopeNamespaces() + 
            this.wsdl.xmlnsInEnvelope + '>' +
            "<soap:Header>" +
                (self.soapHeaders ? self.soapHeaders.join("\n") : "") +
                (self.security ? self.security.toXML() : "") +
            "</soap:Header>" +
            "<soap:Body>" +
                message +
            "</soap:Body>" +
        "</soap:Envelope>";
    
    self.lastRequest = xml;

    if (self.debug_info != null) {
        if (self.debug_info == 'console')
            console.log("XML TO SERVER:\n" + xml + "\n");
        else if (self.debug_info != null)
            require('fs').appendFileSync(self.debug_info, "REQUEST:\n\n" + xml + "\n");
    }
	
    // UNDONE: marcwan, 2013-03-27 -- signature of this function is wacky.
    http.request(location, xml, function(err, response, body) {
        if (self.debug_info != null) {
            if (self.debug_info == 'console')
                console.log("XML RESPONSE:\n" + body + "\n");
            else if (self.debug_info != null)
                require('fs').appendFileSync(self.debug_info, "\nRESPONSE:\n\n" + xml + "\n");
        }

        if (err) {
            callback(err);
        }
        else {
            var die = null;
            try {
                var obj = self.wsdl.xmlToObject(body);
            }
            catch (error) {
                return callback(error, response, body);
            }

            var result = obj.Body[output.$name];
            // RPC/literal response body may contain element named after the method + 'Response'
            // This doesn't necessarily equal the ouput message name. See WSDL 1.1 Section 2.4.5
            if(!result) {
               result = obj.Body[name + 'Response'];
            }
            callback(null, result, body);
        }
    }, headers, options);
}

exports.Client = Client;

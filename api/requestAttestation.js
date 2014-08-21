var reporter = require('../lib/reporter');
var request = require('request');
var response = require('response');
var config = require('../config');
var store = require('../lib/store')(config.dbtype);
var client = require('blockscore')(config.blockscore.key);
var jwtSigner = require('jwt-sign');
var key;
require('fs').readFile('./test.pem', 'utf8', 
function(err, data) {
    if (!err) key = data;
    else console.log("no private key specificed for JWT signing")
})
var conformParams = require('../lib/conformParams')
var Queue = require('queuelib')


var requestAttestation = function(req,res,next) {
   
  if (req.body.type === 'basic_identity') basicIdentityAttestation (req, res, next);
  else if (req.body.type === 'email') emailAttestation (req, res, next);
  else if (req.body.type === 'phone') phoneAttestation (req, res, next);
  else {
    response.json({result:'error', message:'missing or invalid attestion type'}).status(400).pipe(res);    
  }
};

/**
 * basicIdentityAttestation
 * - uses block score to validate name, address, birthdate, and identification
 */

var basicIdentityAttestation = function (req, res, next) {
  
  /*
    1. get existing attestation
    2. check if its not expired
    3. check if its using current profile data
    4. if it passes the tests, serve up the existing one
    5. otherwise request a new one from blockscore
    6. formulate the attestation JWT's
    6. calculate attribute attestation scores and trust score
    7. save attestations and trust score into identity table
    8. return attestation JWT's and trust score
  */
   
    var identity_id = req.params.identity_id;
    reporter.log("requestAttestation:identity_id:", identity_id)
    var q = new Queue
    q.series([
    function(lib) {
        store.read_where({table:'identity_attributes',key:'identity_id', value:identity_id},
        function(resp) {
            reporter.log("getProfile:attributes lookup response:", resp)
            lib.set({attributes:resp})
            lib.done()
        });
    },
    function(lib) {
        store.read_where({table:'identity_addresses',key:'identity_id', value:identity_id},
        function(resp) {
            reporter.log("getProfile:addresses lookup response:", resp)
            lib.set({addresses:resp})
            lib.done()
        });
    },
    function(lib) {
        //get from query string params for now
        var data = {addresses:lib.get('addresses'),attributes:lib.get('attributes')} 
        var result = conformParams(data);

        var code;

        //console.log(result);

        if (result.error) {
        response.json({result:'error', message:result.error}).status(400).pipe(res); 
        lib.terminate()
        return; 
        } 
        var params = result.params;
        console.log("Params sent to blockscore:", params)

        client.verifications.create(params,
        function (err, resp) {
            var result;
            console.log("Blockscore response:",err, resp);
            if (err) {
                code   = 400;
                result = {
                  result  : 'error',
                  message : err.message,
                  error   : err.param + ": " + err.code
                }
            } else if (resp.status === 'invalid') {
                //possibly handle invalid attestation differently
                code   = 200;
                result = {
                    result  : 'success',
                    status  : resp.status,
                    details : resp.details
                };
            //formulate attestation
            } else { 
                var complete;
                var payload;
                var blind;
                var blindPayload;
                
                payload = {
                    iss : "https://id.ripple.com",
                    sub : req.params.identity_id,
                    exp : ~~(new Date().getTime() / 1000) + (30 * 60),
                    iat : ~~(new Date().getTime() / 1000 - 60),
                    given_name  : params.first,
                    family_name : params.last,
                    birthdate   : params.date_of_birth,
                    address : {
                        line1       : params.address.street1,
                        locality    : params.address.city,
                        region      : params.address.state,
                        postal_code : params.address.postal_code,
                        country     : params.address.country_code
                    }
                };
                
                if (params.address.street2) 
                payload.address.line2 = params.address.street2;  
                if (params.identification.ssn)
                payload.ssn_last_4 = params.identification.ssn;
                if (params.identification.passport)
                payload.passport = params.identification.passport
                if (params.phone_number)
                payload.phone = params.phone_number 
                if (params.ip_address) 
                payload.ip_address = params.ip_address
              
                payload.basic_identity_validated = true;
                payload.address_risk             = resp.details.address_risk;
                payload.ofac_match               = resp.details.ofac;
                //payload.pep_match              = resp.details.pep; //ask blockscore what this is
                payload.context_match = {
                  address        : resp.details.address,
                  identification : resp.details.identification,
                  birthdate      : resp.details.date_of_birth,
                };

                    
                //create blinded attestation
                blindPayload = {
                  iss : payload.iss,
                  sub : payload.sub,
                  exp : payload.exp,
                  iat : payload.iat,
                  basic_identity_validated : true,
                  address_risk             : resp.details.address_risk,
                  ofac_match               : resp.details.ofac,
                  //pep_match              : resp.details.pep, //ask blockscore what this is
                  context_match : {
                    address        : resp.details.address,
                    identification : resp.details.identification,
                    birthdate      : resp.details.date_of_birth
                  }
                };
                
                //TODO: recalculate trust score, add to payload
                //TODO: save attestation data in DB
                //TODO: catch error with signing
                complete = jwtSigner.sign(payload, key); 
                blinded  = jwtSigner.sign(blindPayload, key); 
                console.log(payload, blindPayload);
                
                code   = 200;
                result = {
                  result  : 'success',
                  blinded : blinded,
                  complete : complete
                };
            }
            
            response.json(result).status(code).pipe(res);  
            lib.done()
        });
    }
    ]);  
};

/**
 * emailAttestation
 * - uses an email sent from the server with a validation code 
 */
var emailAttestation = function (req, res, next) {
  
};

/*
 * phoneAttestation
 * - uses Authy for verification
 */
var phoneAttestation = function (req, res, next) {
  
};

module.exports = exports = requestAttestation;

import functions_framework
import os
import requests
import json
import logging
from google.cloud import firestore
import datetime

# Setup standard logging
logger = logging.getLogger()

# Global URL
STANFORD_URL = "https://aiapi-prod.stanford.edu/v1/chat/completions"

# Initialize Firestore
if os.environ.get('IP_LIMITING_ENABLED', 'true').lower() == 'true':
    fs_db = firestore.Client(
        project=os.environ.get('PROJECT_ID'), 
        database=os.environ.get('FIRESTORE_DB_NAME')
    )
    fs_collection = fs_db.collection("ip_tracking")

@functions_framework.http
def stanford_proxy(request):
    
    # ==========================================
    # 0. CHECK "MONEY SAVING" SWITCH
    # ==========================================
    # If this is set to "false", we stop immediately. No Stanford API call = No Cost.
    if os.environ.get('SERVICE_ENABLED', 'true').lower() != 'true':
        print("Service is disabled via SERVICE_ENABLED flag.")
        return ({'error': 'Service Temporarily Unavailable'}, 503, {'Access-Control-Allow-Origin': '*'})

    # ==========================================
    # 1. Request Validation
    # ==========================================
    # Handle OPTIONS Request
    ALLOWED_ORIGINS = [x.replace(' ','') for x in os.environ.get('ALLOWED_ORIGINS').split(',')]
    origin = request.headers.get("Origin", "")
    if request.method == 'OPTIONS':
        headers = {
            'Access-Control-Allow-Origin': origin if origin in ALLOWED_ORIGINS else "",
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '3600'
        }
        if os.environ.get('ENDPOINT_KEY_ENABLED', 'false').lower() == 'true': # allow endpoint key in header, if enabled
            headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Survey-Token'

        return ('', 204, headers)
    
    # Check Request Method
    if request.method != 'POST':
        headers = {'Access-Control-Allow-Origin': '*'} # set return headers
        return ({'error': 'Only POST requests are allowed'}, 405, headers)

    # Check Origin
    if os.environ.get('ORIGIN_CHECK_ENABLED', 'true').lower() == 'true':
        if os.environ.get('ENABLE_LOGGING', 'false').lower() == 'true':
            print(f"REQUEST COMING FROM {origin}")
        if not origin or origin not in ALLOWED_ORIGINS:
            return ({'error': 'Unauthorized Access'}, 401, {})
        headers = {'Access-Control-Allow-Origin': origin if origin in ALLOWED_ORIGINS else ""} # set return headers
    else:
        headers = {'Access-Control-Allow-Origin': '*'} # set return headers
    
    # Endpoint Key Check
    if os.environ.get('ENDPOINT_KEY_ENABLED', 'false').lower() == 'true': # check for endpoint key, if enabled
        expected_endpoint_key = os.environ.get('ENDPOINT_KEY')
        provided_endpoint_key = request.headers.get('X-Survey-Token')

        if not provided_endpoint_key or provided_endpoint_key != expected_endpoint_key:
            if os.environ.get('ENABLE_LOGGING', 'false').lower() == 'true':
                print(f"🚫 BLOCKED: Invalid or missing X-Survey-Token from IP.")
            return ({'error': 'Unauthorized Access'}, 401, {})
        
    # IP Tracking
    def get_client_ip(request) -> str:
        """Extract client IP from request headers."""
        # Check for forwarded IP (from load balancer/proxy)
        forwarded_for = request.headers.get("X-Forwarded-For", "")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()
        
        real_ip = request.headers.get("X-Real-Ip", "")
        if real_ip:
            return real_ip
        
        # Fallback (may not be accurate in Cloud Run)
        return request.remote_addr if hasattr(request, "remote_addr") else "unknown"
    client_ip = get_client_ip(request) # get IP of requesting client
    if os.environ.get('IP_LIMITING_ENABLED', 'true').lower() == 'true':
        fs_document = fs_collection.document(client_ip) # pull up document corresponding to client IP address
        doc_details = fs_document.get()
        now = datetime.datetime.now(datetime.timezone.utc) # get current timestamp
        request_date = now.strftime('%Y-%m-%d')
        if doc_details.exists: # check current details
            data = doc_details.to_dict()
            last_call = data.get("last_call")
            total_calls = data.get("total_calls")
            rate_limit_errors = data.get("rate_limit_errors")
            
            # Block if too many total calls
            if total_calls and float(total_calls) >= float(os.environ.get('IP_MAX_CALLS', 1000)):
                fs_document.set({
                    "last_call": now,
                    "total_calls": firestore.Increment(1),
                    "dates_called": firestore.ArrayUnion([request_date])
                }, merge=True)
                return ({'error': 'Too many requests'}, 429, {})

            # Block if too many rate limit errors
            if rate_limit_errors and float(rate_limit_errors) >= float(os.environ.get('IP_MAX_RATE_LIMIT_ERRORS', 50)):
                fs_document.set({
                    "last_call": now,
                    "total_calls": firestore.Increment(1),
                    "dates_called": firestore.ArrayUnion([request_date])
                }, merge=True)
                return ({'error': 'Too many requests'}, 429, {})

            # Rate limit logic: Block if hit too fast
            if last_call and (now - last_call).total_seconds() <= float(os.environ.get('IP_RATE_LIMIT', 1)):
                fs_document.set({
                    "last_call": now,
                    "total_calls": firestore.Increment(1),
                    "rate_limit_errors": firestore.Increment(1),
                    "dates_called": firestore.ArrayUnion([request_date])
                }, merge=True)
                return ({'error': 'Too many requests'}, 429, {})
        
        fs_document.set({
            "last_call": now,
            "total_calls": firestore.Increment(1),
            "dates_called": firestore.ArrayUnion([request_date])
            #"expire_at": now + datetime.timedelta(days=30) # Cleanup in 30d
        }, merge=True)
        if os.environ.get('ENABLE_LOGGING', 'false').lower() == 'true':
            updated_data = fs_document.get().to_dict()
            print(f"IP address {client_ip} has {updated_data.get('total_calls')} total calls out of {os.environ.get('IP_MAX_CALLS')}. Rate limit is {os.environ.get('IP_RATE_LIMIT', 1)} seconds.")    

    # ==========================================
    # 2. Processing
    # ==========================================
    request_json = request.get_json(silent=True)

    if os.environ.get('ENABLE_LOGGING', 'false').lower() == 'true':
        print(f"📥 INCOMING REQUEST: {json.dumps(request_json)}")

    # Auth Check
    api_key = os.environ.get('STANFORD_API_KEY')
    if not api_key:
        print("❌ CRITICAL: STANFORD_API_KEY is missing")
        return ({'error': 'Server configuration error'}, 500, headers)

    try:
        # Extract fields
        user_prompt = request_json.get('prompt')
        system_prompt = request_json.get('system')
        history = request_json.get('history', [])
        model = request_json.get('model', 'gpt-4-turbo')
        temperature = float(request_json.get('temperature', 0.7))
        max_tokens = int(request_json.get('max_tokens', 1000))
        
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if isinstance(history, list):
            messages.extend(history)
        # Defense-in-depth: only append `user_prompt` if it isn't already the
        # last user turn in `history`. The frontend used to send the latest
        # user message in BOTH `prompt` and `history`, which made the model see
        # two consecutive identical user turns (e.g. "3" + "3" -> "33").
        if user_prompt:
            last = messages[-1] if messages else None
            already_present = (
                isinstance(last, dict)
                and last.get("role") == "user"
                and last.get("content") == user_prompt
            )
            if not already_present:
                messages.append({"role": "user", "content": user_prompt})

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens
        }

        # Log the outgoing payload only if logging is on
        if os.environ.get('ENABLE_LOGGING', 'false').lower() == 'true':
            print(f"📤 OUTGOING TO STANFORD: {json.dumps(payload)}")

        # Call Stanford
        stanford_headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        response = requests.post(STANFORD_URL, headers=stanford_headers, json=payload)
        response_data = response.json()

        if response.status_code != 200:
            print(f"❌ UPSTREAM ERROR: {response.status_code} - {response.text}")
            return ({'error': 'Upstream API Error', 'details': response_data}, response.status_code, headers)

        # Success Response
        ai_text = ""
        if 'choices' in response_data and len(response_data['choices']) > 0:
            ai_text = response_data['choices'][0]['message']['content']
        
        return (json.dumps({'text': ai_text}), 200, headers)

    except Exception as e:
        print(f"❌ EXCEPTION: {str(e)}")
        return ({'error': str(e)}, 500, headers)

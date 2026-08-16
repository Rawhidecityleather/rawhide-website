(function(){
  // ---------------------------------------------------------------------------
  // Google tag: Analytics 4 + Ads conversion tracking.
  //
  // Paste your IDs between the quotes below. Anything left empty stays switched
  // off, so a half-filled config never sends junk data.
  //
  //   GA4_ID     Analytics 4 Measurement ID   looks like  G-XXXXXXXXXX
  //   ADS_ID     Google Ads conversion ID     looks like  AW-123456789
  //   ADS_LABEL  Google Ads purchase label    looks like  AbC-D_efGhIjKlM
  //
  // Step-by-step for finding these: see README, "Google tag setup".
  // ---------------------------------------------------------------------------
  var GA4_ID='';
  var ADS_ID='';
  var ADS_LABEL='';

  window.dataLayer=window.dataLayer||[];
  function gtag(){dataLayer.push(arguments)}
  if(GA4_ID||ADS_ID){
    var gt=document.createElement('script');
    gt.async=true;
    gt.src='https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(GA4_ID||ADS_ID);
    document.head.appendChild(gt);
    gtag('js',new Date());
    if(GA4_ID)gtag('config',GA4_ID);
    if(ADS_ID)gtag('config',ADS_ID);
  }

  var toggle=document.querySelector('[data-nav-toggle]');
  var nav=document.querySelector('[data-site-nav]');
  if(toggle&&nav){
    toggle.setAttribute('aria-expanded','false');
    toggle.addEventListener('click',function(){
      var open=nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded',open?'true':'false');
    });
  }
  var year=document.getElementById('year');
  if(year)year.textContent=new Date().getFullYear();

  // Product galleries: click a thumb to swap the main image.
  document.querySelectorAll('[data-gallery]').forEach(function(gallery){
    var main=gallery.querySelector('[data-main]');
    if(!main)return;
    var thumbs=Array.prototype.slice.call(gallery.querySelectorAll('.thumb'));
    thumbs.forEach(function(thumb,i){
      thumb.setAttribute('aria-label','View photo '+(i+1));

      // Thumbs load a small file now, so the full-size version is not sitting in
      // cache when one is clicked. Warm it on hover or first touch and the swap
      // still feels instant, without spending the bytes on visitors who never click.
      var warmed=false;
      var warm=function(){
        if(warmed)return;
        warmed=true;
        var full=thumb.getAttribute('data-full');
        if(full)(new Image()).src=full;
      };
      thumb.addEventListener('pointerenter',warm);
      thumb.addEventListener('touchstart',warm,{passive:true});

      thumb.addEventListener('click',function(){
        var full=thumb.getAttribute('data-full');
        if(!full)return;
        main.src=full;
        var timg=thumb.querySelector('img');
        if(timg&&timg.alt)main.alt=timg.alt;
        thumbs.forEach(function(t){t.classList.remove('active')});
        thumb.classList.add('active');
      });
    });

    // Prev/next arrows over the main image; cycles through visible thumbs.
    if(thumbs.length>1){
      var wrap=document.createElement('div');
      wrap.className='main-image-wrap';
      main.parentNode.insertBefore(wrap,main);
      wrap.appendChild(main);
      var step=function(dir){
        var visible=thumbs.filter(function(t){return t.offsetParent!==null});
        if(visible.length<2)return;
        var cur=0;
        visible.forEach(function(t,idx){if(t.classList.contains('active'))cur=idx});
        visible[(cur+dir+visible.length)%visible.length].click();
      };
      [['prev',-1,'M15 18l-6-6 6-6'],['next',1,'M9 6l6 6-6 6']].forEach(function(cfg){
        var b=document.createElement('button');
        b.type='button';
        b.className='gallery-nav gallery-nav-'+cfg[0];
        b.setAttribute('aria-label',cfg[0]==='prev'?'Previous photo':'Next photo');
        b.innerHTML='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="'+cfg[2]+'"/></svg>';
        b.addEventListener('click',function(){step(cfg[1])});
        wrap.appendChild(b);
      });
    }
  });

  // Checkout wording: the first Snipcart step collects the address that is used
  // for shipping by default, so label the steps for what they really do.
  function setCheckoutLabels(){
    if(!window.Snipcart||!window.Snipcart.api)return;
    window.Snipcart.api.session.setLanguage('en',{
      billing:{title:'Your Address'},
      shipping:{title:'Shipping Method'}
    });
  }
  // There is deliberately no shipping_same_as_billing config call here. That was
  // Snipcart.execute(), the v1/v2 API, and it does not exist in the v3.7.1 theme
  // we load — it threw an uncaught TypeError on every page load and the setting
  // never applied. v3 already checks "use this address for shipping" by default,
  // so true was the behaviour we had regardless. That default is also why the
  // step labels above rename billing to "Your Address".
  document.addEventListener('snipcart.ready',setCheckoutLabels);
  setCheckoutLabels();

  // Order forms: on submit, push the item + all customizations into the Snipcart cart.
  var forms=document.querySelectorAll('[data-order-form]');
  forms.forEach(function(form){
    form.addEventListener('submit',function(e){
      e.preventDefault();
      var product=form.getAttribute('data-product')||'Order';
      var snipId=form.getAttribute('data-snipcart-id');
      var snipPrice=parseFloat(form.getAttribute('data-snipcart-price')||'0');
      var snipImage=form.getAttribute('data-snipcart-image')||'';
      var hiddenBtn=document.querySelector('.snipcart-add-item[data-item-id="'+snipId+'"]');
      var snipUrl=hiddenBtn?hiddenBtn.getAttribute('data-item-url'):location.pathname;

      if(!snipId||!window.Snipcart){
        alert('Cart is still loading. Please wait a moment and try again.');
        return;
      }

      // Forms with option price modifiers (e.g. Custom[+10.00]) must go through
      // Snipcart's own buy-button parser: the cart JS API stores the options but
      // never applies the modifier to the price.
      if(form.querySelector('[data-options]')&&hiddenBtn){
        var idx=0;
        form.querySelectorAll('input,select,textarea').forEach(function(el){
          if(!el.name||el.type==='submit'||el.type==='hidden')return;
          var val=(el.value||'').trim();
          if(!val)return;
          idx++;
          var p='data-item-custom'+idx;
          hiddenBtn.setAttribute(p+'-name',el.getAttribute('data-label')||el.name);
          // Optional fields left blank are skipped above, so a field can land on
          // a different index than the one the static markup declared it at.
          // -options and -type therefore get set or cleared every time: a
          // leftover price modifier from the field that used to sit here would
          // charge for something the customer didn't pick.
          var opts=el.getAttribute('data-options');
          if(opts)hiddenBtn.setAttribute(p+'-options',opts);
          else hiddenBtn.removeAttribute(p+'-options');
          var type=el.getAttribute('data-type')||(el.tagName==='TEXTAREA'?'textarea':'');
          if(type)hiddenBtn.setAttribute(p+'-type',type);
          else hiddenBtn.removeAttribute(p+'-type');
          hiddenBtn.setAttribute(p+'-value',val);
        });
        // Anything declared past the last field used is a ghost from the static
        // markup — Snipcart would render it as an empty extra option.
        Array.prototype.slice.call(hiddenBtn.attributes).forEach(function(attr){
          var m=/^data-item-custom(\d+)-/.exec(attr.name);
          if(m&&Number(m[1])>idx)hiddenBtn.removeAttribute(attr.name);
        });
        hiddenBtn.click();
        setTimeout(function(){if(window.Snipcart)window.Snipcart.api.theme.cart.open();},1600);
        return;
      }

      var customFields=[];
      form.querySelectorAll('input,select,textarea').forEach(function(el){
        if(!el.name||el.type==='submit'||el.type==='hidden')return;
        var label=el.getAttribute('data-label')||el.name;
        var val=(el.value||'').trim();
        if(val) customFields.push({name:label,value:val});
      });

      window.Snipcart.api.cart.items.add({
        id:snipId,
        name:product,
        price:snipPrice,
        url:snipUrl,
        image:snipImage,
        customFields:customFields
      }).then(function(){
        window.Snipcart.api.theme.cart.open();
      }).catch(function(err){
        console.error(err);
        alert('Sorry, something went wrong adding this to your cart. Please try again or email rawhidecityleather@gmail.com.');
      });
    });
  });

  // Artwork uploads. Snipcart has no file-upload field type, so the file goes to
  // our own Worker first and the cart carries the URL it hands back, in an
  // ordinary readonly custom field. Everything here degrades to "email it to us":
  // if the upload fails the customer is told so and can still order.
  var LOGO_MAX = 8 * 1024 * 1024;

  // Add to Cart has to wait for an upload in flight, or the order arrives with an
  // empty artwork field. Counted per form — there are two pickers on the page.
  function uploadPending(form, delta){
    if(!form)return;
    var n = Math.max(0, (Number(form.getAttribute('data-uploading')) || 0) + delta);
    form.setAttribute('data-uploading', String(n));
    var submit = form.querySelector('button[type="submit"]');
    if(!submit)return;
    submit.disabled = n > 0;
    submit.textContent = n > 0 ? 'Uploading artwork...' : 'Add to Cart';
  }

  document.querySelectorAll('[data-logo-upload]').forEach(function(picker){
    var form = picker.closest('form');
    var slot = picker.closest('[data-logo-slot]');
    var field = document.getElementById(picker.getAttribute('data-logo-target'));
    var status = slot ? slot.querySelector('[data-logo-status]') : null;

    function say(message, bad){
      if(!status)return;
      status.textContent = message;
      status.style.color = bad ? 'var(--c-accent)' : 'var(--c-text-soft)';
    }

    picker.addEventListener('change', function(){
      var file = picker.files && picker.files[0];
      if(field) field.value = '';
      if(!file){ say(''); return; }

      // Checked here as well as in the Worker so an 8 MB phone photo fails in
      // one second instead of after the whole upload.
      if(file.size > LOGO_MAX){
        picker.value = '';
        say('That file is over 8 MB. Send a smaller export, or email it after ordering.', true);
        return;
      }

      say('Uploading ' + file.name + '...');
      uploadPending(form, 1);

      var body = new FormData();
      body.append('file', file);

      fetch('/api/logo-upload', { method: 'POST', body: body })
        .then(function(res){
          return res.json()
            .catch(function(){ return { error: 'Upload failed.' }; })
            .then(function(data){
              if(!res.ok || !data.ok) throw new Error(data.error || 'Upload failed.');
              return data;
            });
        })
        .then(function(data){
          // Name and URL together: the name is what the customer recognises in
          // the cart, the URL is what the shop clicks on the packing slip.
          if(field) field.value = data.name + ' - ' + data.url;
          say(data.name + ' attached.');
        })
        .catch(function(err){
          picker.value = '';
          if(field) field.value = '';
          say((err.message || 'Upload failed.') +
            ' You can also email it to rawhidecityleather@gmail.com after ordering.', true);
        })
        .then(function(){ uploadPending(form, -1); });
    });
  });

  // Show one file picker per stamp bought, and only ask for artwork that's
  // actually been paid for.
  document.querySelectorAll('[data-logo-count]').forEach(function(select){
    var form = select.closest('form');
    if(!form) return;
    var slots = form.querySelectorAll('[data-logo-slot]');

    function sync(){
      // "None" parses to NaN, which is the zero we want.
      var wanted = parseInt(select.value, 10) || 0;
      Array.prototype.forEach.call(slots, function(slot){
        var on = Number(slot.getAttribute('data-logo-slot')) <= wanted;
        slot.hidden = !on;

        var picker = slot.querySelector('[data-logo-upload]');
        var field = slot.querySelector('input[name]');
        if(picker) picker.required = on;

        // Clearing on the way down matters: picking two stamps, uploading both,
        // then dropping back to one would otherwise ship a second URL the
        // customer is no longer paying for.
        if(!on){
          if(picker) picker.value = '';
          if(field) field.value = '';
          var status = slot.querySelector('[data-logo-status]');
          if(status) status.textContent = '';
        }
      });
    }

    select.addEventListener('change', sync);
    sync();
  });

  // Newsletter: Kit's script posts the signup, but renders no confirmation in our
  // own markup — so say something ourselves. No preventDefault: if Kit's script is
  // blocked, the form still posts natively and Kit shows its own success page.
  var news = document.querySelector('.newsletter-form');
  if(news){
    news.addEventListener('submit',function(){
      var email=news.querySelector('input[name="email_address"]');
      var btn=news.querySelector('button');
      if(!email||!email.value||!email.checkValidity())return;
      if(btn){btn.disabled=true;btn.textContent='Signing up...'}
      setTimeout(function(){
        var wrap=news.parentNode;
        if(!wrap||wrap.querySelector('[data-news-done]'))return;
        var done=document.createElement('p');
        done.setAttribute('data-news-done','');
        done.style.cssText='margin:0;font-family:var(--font-display);font-weight:600;letter-spacing:.14em;text-transform:uppercase;font-size:.95rem';
        done.textContent="You're on the list. Check your email to confirm.";
        news.style.display='none';
        var fine=wrap.querySelector('.form-help');
        if(fine)fine.style.display='none';
        news.insertAdjacentElement('afterend',done);
      },1200);
    });
  }

  // Custom build / crew inquiry form. Posts into Kit like the newsletter does,
  // with the inquiry details attached to the subscriber record.
  var inquiry=document.querySelector('[data-inquiry-form]');
  if(inquiry){
    // Deep links like /contact?about=crew arrive with the reason already picked,
    // so someone sent here from the crew page isn't restating why they came.
    var about={
      crew:'Crew or bulk order',
      custom:'Custom build',
      order:'Question about an existing order',
      review:'Leave a review'
    }[(location.search.match(/[?&]about=([^&]*)/)||[])[1]];
    if(about){
      var aboutSel=inquiry.querySelector('#ct-about');
      // The options carry no value attribute, so their text is their value.
      if(aboutSel&&Array.prototype.some.call(aboutSel.options,function(o){return o.text===about})){
        aboutSel.value=about;
      }
    }

    // Everything typed in, as plain text — used for the email fallback below.
    var inquiryAsText=function(){
      var lines=[];
      inquiry.querySelectorAll('input,select,textarea').forEach(function(el){
        if(!el.name||el.type==='submit')return;
        var val=(el.value||'').trim();
        if(!val)return;
        var lbl=inquiry.querySelector('label[for="'+el.id+'"]');
        lines.push((lbl?lbl.textContent.replace('*','').trim():el.name)+': '+val);
      });
      return lines.join('\n');
    };

    inquiry.addEventListener('submit',function(e){
      // The Kit form id is a placeholder until it's filled in. Rather than post an
      // inquiry into a dead endpoint and lose it, hand it off to email with
      // everything they typed already in the body.
      if((inquiry.getAttribute('action')||'').indexOf('KIT_FORM_ID')!==-1){
        e.preventDefault();
        window.location.href='mailto:rawhidecityleather@gmail.com'
          +'?subject='+encodeURIComponent('Website inquiry')
          +'&body='+encodeURIComponent(inquiryAsText());
        return;
      }
      // Kit's script posts this, but renders no confirmation in our own markup.
      var btn=inquiry.querySelector('button[type="submit"]');
      if(btn){btn.disabled=true;btn.textContent='Sending...'}
      setTimeout(function(){
        var wrap=inquiry.parentNode;
        if(!wrap||wrap.querySelector('[data-inquiry-done]'))return;
        var done=document.createElement('p');
        done.setAttribute('data-inquiry-done','');
        done.style.cssText='margin:0;font-family:var(--font-display);font-weight:600;letter-spacing:.14em;text-transform:uppercase;font-size:.95rem;text-align:center';
        done.textContent="Got it. We'll be in touch within 24 hours.";
        inquiry.style.display='none';
        inquiry.insertAdjacentElement('afterend',done);
      },1200);
    });
  }

  // Product pages carry their details on the order form; reuse them for analytics
  // rather than restating every price in a second place that can drift.
  function pageProduct(){
    var f=document.querySelector('[data-order-form]');
    if(!f)return null;
    var id=f.getAttribute('data-snipcart-id');
    if(!id)return null;
    return {
      id:id,
      name:f.getAttribute('data-product')||'',
      price:parseFloat(f.getAttribute('data-snipcart-price')||'0')||0
    };
  }

  // Viewing a product is the signal both ad platforms retarget on, so send it on
  // arrival rather than waiting for a cart action most visitors never take.
  var viewed=pageProduct();
  if(viewed){
    if(typeof fbq==='function'){
      fbq('track','ViewContent',{
        content_type:'product',
        content_ids:[viewed.id],
        content_name:viewed.name,
        value:viewed.price,
        currency:'USD'
      });
    }
    if(GA4_ID){
      gtag('event','view_item',{
        currency:'USD',
        value:viewed.price,
        items:[{item_id:viewed.id,item_name:viewed.name,price:viewed.price}]
      });
    }
  }

  // Forward cart activity to both ad platforms so campaigns can optimize on
  // sales, not just visits. Each platform is guarded on its own: if one is
  // blocked or unconfigured, the other still reports.
  document.addEventListener('snipcart.ready',function(){
    if(!window.Snipcart||!Snipcart.events)return;
    var meta=(typeof fbq==='function');

    Snipcart.events.on('item.added',function(item){
      var value=Math.round((item.totalPrice||item.price||0)*100)/100;
      if(meta)fbq('track','AddToCart',{
        content_type:'product',
        content_ids:[item.id],
        content_name:item.name,
        value:value,
        currency:'USD'
      });
      if(GA4_ID)gtag('event','add_to_cart',{
        currency:'USD',
        value:value,
        items:[{item_id:item.id,item_name:item.name,price:value}]
      });
    });

    Snipcart.events.on('theme.routechanged',function(routes){
      // Fire once when the buyer enters checkout, not on steps within it.
      if(!routes||!routes.to||routes.to.indexOf('/checkout')!==0)return;
      if(routes.from&&routes.from.indexOf('/checkout')===0)return;
      if(meta)fbq('track','InitiateCheckout');
      if(GA4_ID)gtag('event','begin_checkout');
    });

    Snipcart.events.on('cart.confirmed',function(cart){
      // cart.items is {count,items:[...]} in current SDK builds, a plain array in older ones.
      var items=(cart&&cart.items&&cart.items.items)||(cart&&cart.items)||[];
      var ids=[],lineItems=[],count=0;
      if(items.forEach)items.forEach(function(it){
        ids.push(it.id);
        count+=(it.quantity||1);
        lineItems.push({item_id:it.id,item_name:it.name,price:it.price,quantity:it.quantity||1});
      });
      // Snipcart's total is what was actually charged, so the 20% cart discount
      // is already taken out — report that, not the sum of list prices.
      var value=Math.round(((cart&&cart.total)||0)*100)/100;
      var currency=(cart&&cart.currency)?String(cart.currency).toUpperCase():'USD';
      // Order id lets both platforms drop duplicate conversions on a page refresh.
      var orderId=(cart&&(cart.invoiceNumber||cart.token))||undefined;

      if(meta)fbq('track','Purchase',{
        content_type:'product',
        content_ids:ids,
        value:value,
        currency:currency,
        num_items:count
      });
      if(GA4_ID)gtag('event','purchase',{
        transaction_id:orderId,
        value:value,
        currency:currency,
        items:lineItems
      });
      if(ADS_ID&&ADS_LABEL)gtag('event','conversion',{
        send_to:ADS_ID+'/'+ADS_LABEL,
        value:value,
        currency:currency,
        transaction_id:orderId
      });
    });
  });
})();

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
  document.addEventListener('snipcart.ready',setCheckoutLabels);
  document.addEventListener('snipcart.ready',function(){
    Snipcart.execute('config','shipping_same_as_billing',true);
  });
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
          var opts=el.getAttribute('data-options');
          if(opts)hiddenBtn.setAttribute(p+'-options',opts);
          if(el.tagName==='TEXTAREA')hiddenBtn.setAttribute(p+'-type','textarea');
          hiddenBtn.setAttribute(p+'-value',val);
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

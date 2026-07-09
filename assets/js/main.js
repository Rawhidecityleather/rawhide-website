(function(){
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
      thumb.setAttribute('aria-label','View photo '+(i+1));thumb.addEventListener('click',function(){
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
})();

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
    gallery.querySelectorAll('.thumb').forEach(function(thumb,i){
      thumb.setAttribute('aria-label','View photo '+(i+1));thumb.addEventListener('click',function(){
        var full=thumb.getAttribute('data-full');
        if(!full)return;
        main.src=full;
        var timg=thumb.querySelector('img');
        if(timg&&timg.alt)main.alt=timg.alt;
        gallery.querySelectorAll('.thumb').forEach(function(t){t.classList.remove('active')});
        thumb.classList.add('active');
      });
    });
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

      var customFields=[];
      form.querySelectorAll('input,select,textarea').forEach(function(el){
        if(!el.name||el.type==='submit'||el.type==='hidden')return;
        var label=el.getAttribute('data-label')||el.name;
        var val=(el.value||'').trim();
        if(!val)return;
        var field={name:label,value:val};
        // Options with [+X.00] price modifiers must also be declared on the
        // hidden snipcart-add-item button so Snipcart's crawler can verify them.
        var opts=el.getAttribute('data-options');
        if(opts)field.options=opts;
        customFields.push(field);
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

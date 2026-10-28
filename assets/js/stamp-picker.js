(function(){
  // ---------------------------------------------------------------------------
  // The stamp catalogue, by number.
  //
  // One list for every page that offers stamps. The numbers are the ones
  // written on the sample boards in the shop, so a customer's "12" means the
  // same cross on the order form, on the packing slip and on the bench. New
  // stamps go on the end; a number is never reused, so an old order still reads
  // right.
  //
  // Each entry is [number, short name]. The tile is assets/img/stamps/NN.webp.
  // ---------------------------------------------------------------------------
  var STAMPS = [
    [1, 'Flag Maltese'],
    [2, 'FD Maltese'],
    [3, 'IAFF Maltese'],
    [4, 'Fire Dept Maltese'],
    [5, 'Star of Life'],
    [6, 'Thin Red Line Maltese'],
    [7, 'Scramble'],
    [8, 'EMS Maltese'],
    [9, '9/11 343 Maltese'],
    [10, 'Flag Star of Life'],
    [11, 'Flag Punisher'],
    [12, 'Cross'],
    [13, 'Bold cross'],
    [14, 'Hazmat diamond'],
    [15, 'Crossed axes'],
    [16, 'Irons'],
    [17, 'Minion, pike pole'],
    [18, 'Minion, radio'],
    [19, 'Grogu'],
    [20, 'Mandalorian helmet'],
    [21, 'Fleur-de-lis'],
    [22, 'Bear paw'],
    [23, 'FD skull'],
    [24, 'Flaming grin'],
    [25, 'F-bomb'],
    [26, 'Shamrock'],
    [27, 'W diamond'],
    [28, 'Four-leaf clover'],
    [29, 'US flag'],
    [30, 'Flag, halligan'],
    [31, 'Tattered flag, axe'],
    [32, 'Flag, axe'],
    [33, 'Florida'],
    [34, 'Two bugles'],
    [35, 'Crossed bugles'],
    [36, 'Star'],
    [37, 'Block O'],
    [38, 'Awareness ribbon'],
    [39, 'Job Town ticket'],
    [40, 'Maltese with cross'],
    [41, 'Maltese with cross, bold'],
    [42, 'Marine Corps EGA'],
    [43, 'Navy Chief anchor'],
    [44, 'Killin’ Me Smalls'],
    [45, 'Spartan flag helmet'],
    [46, 'Punisher skull'],
    [47, 'Flying duck'],
    [48, 'Spade'],
    [49, 'Diamond'],
    [50, 'Club'],
    [51, 'Heart'],
    // Pressed Oct 28 2026. 52 is the CFD department monogram (name confirmed by Rob).
    [52, 'CFD monogram'],
    [53, 'Packers G'],
    [54, 'Oklahoma OU'],
    [55, 'Liverpool liver bird']
  ];

  // Served out of /assets, so the path works from a product page at the root
  // and from the dashboard's preview alike.
  var TILE_DIR = '/assets/img/stamps/';

  function pad(n){ return (n < 10 ? '0' : '') + n; }

  // What goes on the order: the number first, so it reads the same way the
  // boards do, then the name so nobody has to look the number up.
  function valueOf(entry){ return entry[0] + ' - ' + entry[1]; }

  window.RCL_STAMPS = STAMPS;

  document.querySelectorAll('[data-stamp-picker]').forEach(function(wrap){
    var select = wrap.querySelector('select[data-stamp-pick]');
    var grid = wrap.querySelector('[data-stamp-grid]');
    if(!select || !grid) return;

    // The page ships the select with only "None" on it. The numbered choices
    // come from the one list above, so the dropdown and the tiles can never
    // disagree about what number 12 is.
    STAMPS.forEach(function(entry){
      var opt = document.createElement('option');
      opt.value = valueOf(entry);
      opt.textContent = entry[0] + ' · ' + entry[1];
      select.appendChild(opt);
    });

    var tiles = {};

    function tile(value, label, img, number){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'stamp-tile';
      b.setAttribute('data-value', value);
      b.setAttribute('title', label);
      b.setAttribute('aria-label', label);
      if(img){
        var i = document.createElement('img');
        i.src = img; i.alt = ''; i.width = 96; i.height = 96; i.loading = 'lazy'; i.decoding = 'async';
        b.appendChild(i);
      }
      var n = document.createElement('span');
      n.className = 'stamp-num';
      n.textContent = number;
      b.appendChild(n);
      b.addEventListener('click', function(){
        select.value = value;
        fold(false);
        if(browse) browse.focus();
        // A real change event, so anything else listening to the select
        // (the preview below, the form) hears it the same way a keyboard pick
        // sounds.
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      tiles[value] = b;
      return b;
    }

    grid.appendChild(tile('', 'No stamp', '', 'None'));
    STAMPS.forEach(function(entry){
      grid.appendChild(tile(valueOf(entry), entry[0] + ' · ' + entry[1], TILE_DIR + pad(entry[0]) + '.webp', entry[0]));
    });

    var preview = wrap.querySelector('[data-stamp-preview]');

    // The grid is big — 55 tiles, twice on a page — so it stays folded behind
    // a button until the customer asks for it, and folds away again once they
    // have tapped a stamp. The dropdown above it is always there for anyone
    // who already knows the number off the boards.
    var browse = wrap.querySelector('[data-stamp-browse]');
    function fold(open){
      grid.hidden = !open;
      if(browse){
        browse.setAttribute('aria-expanded', open ? 'true' : 'false');
        browse.textContent = open ? 'Hide the stamps' : 'Browse the stamps';
      }
    }
    if(browse) browse.addEventListener('click', function(){ fold(grid.hidden); });

    function sync(){
      var v = select.value;
      Object.keys(tiles).forEach(function(k){
        var on = k === v;
        tiles[k].classList.toggle('active', on);
        tiles[k].setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if(preview){
        var entry = null;
        STAMPS.forEach(function(e){ if(valueOf(e) === v) entry = e; });
        if(entry){
          preview.hidden = false;
          preview.querySelector('img').src = TILE_DIR + pad(entry[0]) + '.webp';
          preview.querySelector('[data-stamp-preview-name]').textContent = '#' + entry[0] + ' ' + entry[1];
        } else {
          preview.hidden = true;
        }
      }
    }

    select.addEventListener('change', sync);
    sync();
  });
})();

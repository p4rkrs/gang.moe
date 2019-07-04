const random_images_array = ["01.png", "02.png", "03.png", "04.png", "05.png", "06.png", "07.png", "08.png", "09.png", "10.png", "11.png", "12.png", "13.png", "14.png", "15.png", "16.png", "17.png", "18.png", "19.png", "20.png", "21.png", "22.png", "23.png", "24.png", "25.png"];
const path = '/images/grill/'
const num = Math.floor( Math.random() * random_images_array.length );
const img = random_images_array[ num ];
const imgStr = '<img class="logo" src="' + path + img + '">';

document.write(imgStr); document.close();